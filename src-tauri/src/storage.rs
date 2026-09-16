use crate::{
    contracts::Project,
    paths::{io, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Registry {
    projects: Vec<Project>,
    // 保留被移除项目的身份，重新添加同一路径时恢复原配色和排期。
    #[serde(default)]
    removed_projects: Vec<Project>,
}

pub struct Storage {
    pub data_dir: PathBuf,
    pub projects: Vec<Project>,
    pub persistent: Vec<Project>,
    registry_error: Option<String>,
    removed_projects: Vec<Project>,
}
impl Storage {
    pub fn new(data_dir: PathBuf) -> Self {
        let (registry, registry_error) = match fs::read(data_dir.join("projects.json")) {
            Ok(bytes) => match serde_json::from_slice::<Registry>(&bytes) {
                Ok(registry) => (registry, None),
                Err(e) => (
                    Registry::default(),
                    Some(format!("INVALID_REGISTRY: existing config preserved: {e}")),
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Registry::default(), None),
            Err(e) => (Registry::default(), Some(io(e))),
        };
        let persistent = registry.projects;
        let fixture_paths = std::env::var("TRELLIS_PERF_PROJECTS").ok();
        let projects = registered_projects(&persistent, fixture_paths.as_deref());
        Self {
            data_dir,
            projects,
            persistent,
            registry_error,
            removed_projects: registry.removed_projects,
        }
    }
    pub fn add(&mut self, path: &Path) -> Result<Project> {
        if let Some(error) = &self.registry_error {
            return Err(error.clone());
        }
        let project = project_from_path(path)?;
        if let Some(existing) = self.projects.iter().find(|p| p.path == project.path) {
            return Ok(existing.clone());
        }
        let mut removed = self.removed_projects.clone();
        let project = if let Some(index) = removed.iter().position(|old| old.path == project.path) {
            let previous = removed.remove(index);
            Project {
                id: previous.id,
                ..project
            }
        } else {
            project
        };
        let mut next = self.persistent.clone();
        next.push(project.clone());
        self.save_registry(next, removed)?;
        self.projects.push(project.clone());
        Ok(project)
    }

    pub fn remove(&mut self, id: &str) -> Result<Vec<Project>> {
        let project = self
            .projects
            .iter()
            .find(|project| project.id == id)
            .cloned()
            .ok_or("PROJECT_UNAVAILABLE: unregistered project")?;
        let mut next = self.persistent.clone();
        let mut removed = self.removed_projects.clone();
        // 性能样本只存在于运行时，不将其写入用户的项目登记。
        if next.iter().any(|item| item.id == id) {
            next.retain(|item| item.id != id);
            removed.retain(|item| item.path != project.path);
            removed.push(project);
            self.save_registry(next, removed)?;
        }
        self.projects.retain(|item| item.id != id);
        Ok(self.projects.clone())
    }

    fn save_registry(
        &mut self,
        projects: Vec<Project>,
        removed_projects: Vec<Project>,
    ) -> Result<()> {
        if let Some(error) = &self.registry_error {
            return Err(error.clone());
        }
        fs::create_dir_all(&self.data_dir).map_err(io)?;
        let temporary = self.data_dir.join("projects.json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&Registry {
                projects: projects.clone(),
                removed_projects: removed_projects.clone(),
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(io)?;
        fs::rename(temporary, self.data_dir.join("projects.json")).map_err(io)?;
        // 持久化成功后再发布内存状态，失败时保留列表和恢复记录。
        self.persistent = projects;
        self.removed_projects = removed_projects;
        Ok(())
    }
}
fn project_from_path(path: &Path) -> Result<Project> {
    let actual = path.canonicalize().map_err(io)?;
    if !actual.join(".trellis").is_dir() {
        return Err("PROJECT_UNAVAILABLE: selected directory has no .trellis directory".into());
    }
    Ok(Project {
        id: uuid::Uuid::new_v4().to_string(),
        name: actual
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        path: actual.to_string_lossy().to_string(),
    })
}

fn registered_projects(persistent: &[Project], fixture_paths: Option<&str>) -> Vec<Project> {
    let mut projects = if fixture_paths.is_some() {
        vec![]
    } else {
        persistent.to_vec()
    };
    if let Some(value) = fixture_paths {
        if let Ok(paths) = serde_json::from_str::<Vec<String>>(value) {
            for path in paths {
                if Path::new(&path).is_absolute() {
                    if let Ok(project) = project_from_path(Path::new(&path)) {
                        if !projects.iter().any(|p| p.path == project.path) {
                            projects.push(project);
                        }
                    }
                }
            }
        }
    }
    projects
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removal_survives_restart_and_restores_identity_without_touching_source_or_planner() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join(".trellis")).unwrap();
        fs::write(source.path().join("keep.txt"), "source").unwrap();
        let mut storage = Storage::new(data.path().into());
        let project = storage.add(source.path()).unwrap();
        let planner = format!(
            r##"{{"projectColors":{{"{}":"#123456"}},"schedules":[{{"projectId":"{}"}}]}}"##,
            project.id, project.id
        );
        fs::write(data.path().join("planner.json"), &planner).unwrap();
        assert!(storage.remove(&project.id).unwrap().is_empty());
        assert!(storage.remove(&project.id).is_err());
        let mut reopened = Storage::new(data.path().into());
        assert!(reopened.projects.is_empty());
        assert_eq!(reopened.add(source.path()).unwrap().id, project.id);
        assert_eq!(reopened.add(source.path()).unwrap().id, project.id);
        assert_eq!(reopened.projects.len(), 1);
        assert_eq!(
            fs::read_to_string(data.path().join("planner.json")).unwrap(),
            planner
        );
        assert_eq!(
            fs::read_to_string(source.path().join("keep.txt")).unwrap(),
            "source"
        );
    }

    #[test]
    fn old_registry_is_compatible_and_failed_remove_keeps_active_state() {
        let data = tempfile::tempdir().unwrap();
        fs::write(
            data.path().join("projects.json"),
            r#"{"projects":[{"id":"old","name":"旧项目","path":"/old"}]}"#,
        )
        .unwrap();
        let mut storage = Storage::new(data.path().into());
        // 用目录占用临时文件位置，确定性模拟持久化失败。
        fs::create_dir(data.path().join("projects.json.tmp")).unwrap();
        assert!(storage.remove("old").is_err());
        assert_eq!(storage.projects[0].id, "old");
        assert!(storage.removed_projects.is_empty());
        assert_eq!(Storage::new(data.path().into()).projects[0].id, "old");
    }

    #[test]
    fn performance_registration_isolated_from_saved_projects() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".trellis")).unwrap();
        let saved = vec![Project {
            id: "saved".into(),
            name: "personal".into(),
            path: "/personal".into(),
        }];
        let fixtures = serde_json::to_string(&vec![dir.path().to_string_lossy()]).unwrap();
        let projects = registered_projects(&saved, Some(&fixtures));
        assert_eq!(projects.len(), 1);
        assert_ne!(projects[0].id, "saved");
        assert_eq!(registered_projects(&saved, None)[0].id, "saved");
        assert!(registered_projects(&saved, Some("invalid")).is_empty());
    }
}
