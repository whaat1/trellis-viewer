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
}

pub struct Storage {
    pub data_dir: PathBuf,
    pub projects: Vec<Project>,
    pub persistent: Vec<Project>,
    registry_error: Option<String>,
}
impl Storage {
    pub fn new(data_dir: PathBuf) -> Self {
        let (persistent, registry_error) = match fs::read(data_dir.join("projects.json")) {
            Ok(bytes) => match serde_json::from_slice::<Registry>(&bytes) {
                Ok(registry) => (registry.projects, None),
                Err(e) => (
                    vec![],
                    Some(format!("INVALID_REGISTRY: existing config preserved: {e}")),
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (vec![], None),
            Err(e) => (vec![], Some(io(e))),
        };
        let fixture_paths = std::env::var("TRELLIS_PERF_PROJECTS").ok();
        let projects = registered_projects(&persistent, fixture_paths.as_deref());
        Self {
            data_dir,
            projects,
            persistent,
            registry_error,
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
        let mut next = self.persistent.clone();
        next.push(project.clone());
        fs::create_dir_all(&self.data_dir).map_err(io)?;
        let temporary = self.data_dir.join("projects.json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&Registry {
                projects: next.clone(),
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(io)?;
        fs::rename(temporary, self.data_dir.join("projects.json")).map_err(io)?;
        self.persistent = next;
        self.projects.push(project.clone());
        Ok(project)
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
