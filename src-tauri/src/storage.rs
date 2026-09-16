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
    #[serde(default)]
    removed_projects: Vec<Project>,
}

pub struct Storage {
    pub data_dir: PathBuf,
    pub projects: Vec<Project>,
    pub persistent: Vec<Project>,
    registry_error: Option<String>,
    fixture_mode: bool,
    removed_projects: Vec<Project>,
}
impl Storage {
    fn persist(&mut self, next: Vec<Project>, removed: Vec<Project>) -> Result<()> {
        if self.fixture_mode {
            self.projects = next;
            self.removed_projects = removed;
            return Ok(());
        }
        if let Some(error) = &self.registry_error {
            return Err(error.clone());
        }
        fs::create_dir_all(&self.data_dir).map_err(io)?;
        let temporary = self.data_dir.join("projects.json.tmp");
        let bytes = serde_json::to_vec_pretty(&Registry {
            projects: next.clone(),
            removed_projects: removed.clone(),
        })
        .map_err(|e| e.to_string())?;
        use std::io::Write;
        let mut file = fs::File::create(&temporary).map_err(io)?;
        file.write_all(&bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        fs::rename(temporary, self.data_dir.join("projects.json")).map_err(io)?;
        self.removed_projects = removed;
        self.persistent = next.clone();
        self.projects = next;
        Ok(())
    }
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
            fixture_mode: fixture_paths.is_some(),
            removed_projects: if fixture_paths.is_some() {
                vec![]
            } else {
                registry.removed_projects
            },
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
            Project {
                id: removed.remove(index).id,
                ..project
            }
        } else {
            project
        };
        let mut next = self.projects.clone();
        next.push(project.clone());
        self.persist(next, removed)?;
        Ok(project)
    }
    pub fn remove(&mut self, id: &str) -> Result<()> {
        let project = self
            .projects
            .iter()
            .find(|project| project.id == id)
            .cloned()
            .ok_or("PROJECT_UNAVAILABLE: unregistered project")?;
        let mut removed = self.removed_projects.clone();
        removed.retain(|old| old.path != project.path);
        removed.push(project);
        let next = self
            .projects
            .iter()
            .filter(|p| p.id != id)
            .cloned()
            .collect();
        self.persist(next, removed)
    }
    pub fn reorder(&mut self, ids: &[String]) -> Result<()> {
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        if ids.len() != self.projects.len()
            || unique.len() != ids.len()
            || ids
                .iter()
                .any(|id| !self.projects.iter().any(|p| &p.id == id))
        {
            return Err("INVALID_PROJECT_ORDER: projects must be a complete permutation".into());
        }
        let next = ids
            .iter()
            .filter_map(|id| self.projects.iter().find(|p| &p.id == id).cloned())
            .collect();
        self.persist(next, self.removed_projects.clone())
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
        storage.remove(&project.id).unwrap();
        assert!(storage.projects.is_empty());
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

    fn setup() -> (tempfile::TempDir, Storage) {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = Storage::new(dir.path().join("settings"));
        for name in ["a", "b"] {
            let root = dir.path().join(name);
            fs::create_dir_all(root.join(".trellis")).unwrap();
            storage.add(&root).unwrap();
        }
        (dir, storage)
    }
    #[test]
    fn registry_reorders_and_removes_without_touching_source() {
        let (dir, mut storage) = setup();
        let ids: Vec<_> = storage
            .projects
            .iter()
            .rev()
            .map(|p| p.id.clone())
            .collect();
        storage.reorder(&ids).unwrap();
        assert_eq!(
            Storage::new(storage.data_dir.clone()).projects[0].id,
            ids[0]
        );
        storage.remove(&ids[0]).unwrap();
        assert_eq!(Storage::new(storage.data_dir.clone()).projects.len(), 1);
        assert!(dir.path().join("b/.trellis").is_dir());
        assert!(storage.remove(&ids[0]).is_err());
    }
    #[test]
    fn invalid_order_and_failed_write_preserve_memory_and_disk() {
        let (_dir, mut storage) = setup();
        let original = fs::read(storage.data_dir.join("projects.json")).unwrap();
        let ids: Vec<_> = storage.projects.iter().map(|p| p.id.clone()).collect();
        for invalid in [
            vec![ids[0].clone(), ids[0].clone()],
            vec![ids[0].clone()],
            vec![ids[0].clone(), "unknown".into()],
        ] {
            assert!(storage.reorder(&invalid).is_err());
        }
        fs::create_dir(storage.data_dir.join("projects.json.tmp")).unwrap();
        assert!(storage.remove(&ids[0]).is_err());
        assert!(storage.reorder(&[ids[1].clone(), ids[0].clone()]).is_err());
        assert_eq!(storage.projects[0].id, ids[0]);
        assert_eq!(storage.projects.len(), 2);
        assert_eq!(
            fs::read(storage.data_dir.join("projects.json")).unwrap(),
            original
        );
    }
    #[test]
    fn fixture_mutations_preserve_ids_and_personal_registry() {
        let (dir, mut storage) = setup();
        let original = fs::read(storage.data_dir.join("projects.json")).unwrap();
        let fixture = project_from_path(&dir.path().join("a")).unwrap();
        storage.fixture_mode = true;
        storage.projects = vec![fixture.clone()];
        storage.reorder(std::slice::from_ref(&fixture.id)).unwrap();
        assert_eq!(storage.projects[0].id, fixture.id);
        storage.remove(&fixture.id).unwrap();
        storage.add(&dir.path().join("b")).unwrap();
        assert_eq!(storage.projects.len(), 1);
        assert_eq!(storage.persistent.len(), 2);
        assert_eq!(
            fs::read(storage.data_dir.join("projects.json")).unwrap(),
            original
        );
    }
    #[test]
    fn corrupt_registry_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("projects.json"), "broken").unwrap();
        let mut storage = Storage::new(dir.path().to_path_buf());
        assert!(storage.reorder(&[]).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json")).unwrap(),
            "broken"
        );
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
