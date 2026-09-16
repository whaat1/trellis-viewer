use crate::{
    contracts::{CalendarProject, PlannerSettings, Project, ScheduleEntry, ScheduleUpdate},
    index::Index,
    paths::{self, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPlanner {
    schema_version: u32,
    #[serde(flatten)]
    settings: PlannerSettings,
}

pub struct Planner {
    path: PathBuf,
    settings: PlannerSettings,
    load_error: Option<String>,
}
impl Planner {
    pub fn new(data_dir: PathBuf) -> Self {
        let path = data_dir.join("planner.json");
        let loaded = match fs::read(&path) {
            Ok(bytes) => decode_settings(&bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(PlannerSettings::default())
            }
            Err(error) => Err(paths::io(error)),
        };
        match loaded {
            Ok(settings) => Self {
                path,
                settings,
                load_error: None,
            },
            Err(error) => Self {
                path,
                settings: PlannerSettings::default(),
                load_error: Some(format!(
                    "INVALID_PLANNER: existing planner preserved: {error}"
                )),
            },
        }
    }
    pub fn settings(&self) -> Result<PlannerSettings> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        Ok(self.settings.clone())
    }
    fn save(&mut self, settings: PlannerSettings) -> Result<PlannerSettings> {
        self.settings()?;
        let bytes = serde_json::to_vec_pretty(&SavedPlanner {
            schema_version: 1,
            settings: settings.clone(),
        })
        .map_err(|e| e.to_string())?;
        let directory = self
            .path
            .parent()
            .ok_or("INVALID_PLANNER: missing application directory")?;
        fs::create_dir_all(directory).map_err(paths::io)?;
        let temporary = directory.join(format!("planner-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(paths::io)?;
            file.write_all(&bytes).map_err(paths::io)?;
            file.sync_all().map_err(paths::io)?;
            fs::rename(&temporary, &self.path).map_err(paths::io)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        self.settings = settings.clone();
        Ok(settings)
    }
    pub fn color(&mut self, project_id: String, color: String) -> Result<PlannerSettings> {
        validate_color(&color)?;
        let mut settings = self.settings()?;
        settings.project_colors.insert(project_id, color);
        self.save(settings)
    }
    pub fn clear(&mut self, input: &ScheduleUpdate) -> Result<PlannerSettings> {
        validate_range(input.start_date.as_deref(), input.end_date.as_deref())?;
        if input.start_date.is_some() {
            return Err("INVALID_SCHEDULE: clear requires two null dates".into());
        }
        let mut settings = self.settings()?;
        if let Some(id) = &input.id {
            let old = settings
                .schedules
                .iter()
                .find(|entry| entry.id == *id)
                .ok_or("SCHEDULE_NOT_FOUND: schedule ID is unknown")?;
            if old.project_id != input.project_id {
                return Err("INVALID_SCHEDULE: schedule belongs to another project".into());
            }
            settings.schedules.retain(|entry| entry.id != *id);
        } else {
            settings.schedules.retain(|entry| {
                entry.project_id != input.project_id || entry.task_key != input.task_key
            });
        }
        self.save(settings)
    }
    pub fn update(
        &mut self,
        input: ScheduleUpdate,
        project: &Project,
        calendar: &CalendarProject,
    ) -> Result<PlannerSettings> {
        validate_range(input.start_date.as_deref(), input.end_date.as_deref())?;
        if input.project_id != project.id || calendar.project_id != project.id {
            return Err("INVALID_SCHEDULE: project mismatch".into());
        }
        if input.start_date.is_none() {
            return self.clear(&input);
        }
        paths::safe_relative(&input.task_key)?;
        let mut settings = self.settings()?;
        let task = calendar
            .tasks
            .iter()
            .find(|task| task.key == input.task_key)
            .ok_or("TASK_NOT_FOUND: task is missing or unresolved")?;
        if task.status == "cancelled" {
            return Err("INVALID_SCHEDULE: cancelled tasks cannot be scheduled".into());
        }
        let old_index = if let Some(id) = &input.id {
            let index = settings
                .schedules
                .iter()
                .position(|entry| entry.id == *id)
                .ok_or("SCHEDULE_NOT_FOUND: schedule ID is unknown")?;
            let old = &settings.schedules[index];
            if old.project_id != input.project_id {
                return Err("INVALID_SCHEDULE: schedule belongs to another project".into());
            }
            if old.task_key != input.task_key {
                let root = paths::tasks_root(project)?;
                let old_path = root.join(paths::safe_relative(&old.task_key)?);
                let basename = old.task_key.rsplit('/').next().unwrap_or("");
                if old_path.try_exists().map_err(paths::io)?
                    || input.task_key.rsplit('/').next() != Some(basename)
                    || calendar
                        .tasks
                        .iter()
                        .filter(|task| task.key.rsplit('/').next() == Some(basename))
                        .count()
                        != 1
                {
                    return Err(
                        "AMBIGUOUS_SCHEDULE: old task cannot be safely associated with this task"
                            .into(),
                    );
                }
            }
            Some(index)
        } else {
            settings.schedules.iter().position(|entry| {
                entry.project_id == input.project_id && entry.task_key == input.task_key
            })
        };
        if settings.schedules.iter().enumerate().any(|(i, entry)| {
            Some(i) != old_index
                && entry.project_id == input.project_id
                && entry.task_key == input.task_key
        }) {
            return Err("INVALID_SCHEDULE: task already has another schedule".into());
        }
        let entry = ScheduleEntry {
            id: old_index
                .map(|i| settings.schedules[i].id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            project_id: input.project_id,
            task_key: input.task_key,
            title: task.title.clone(),
            start_date: input.start_date.unwrap(),
            end_date: input.end_date.unwrap(),
        };
        match old_index {
            Some(i) => settings.schedules[i] = entry,
            None => settings.schedules.push(entry),
        }
        self.save(settings)
    }
}

fn decode_settings(bytes: &[u8]) -> Result<PlannerSettings> {
    let saved: SavedPlanner = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if saved.schema_version != 1 {
        return Err("unsupported planner schema version".into());
    }
    for color in saved.settings.project_colors.values() {
        validate_color(color)?;
    }
    let mut ids = HashSet::new();
    let mut tasks = HashSet::new();
    for entry in &saved.settings.schedules {
        if uuid::Uuid::parse_str(&entry.id).is_err()
            || !ids.insert(&entry.id)
            || entry.project_id.is_empty()
            || !tasks.insert((&entry.project_id, &entry.task_key))
        {
            return Err("invalid or duplicate schedule identity".into());
        }
        paths::safe_relative(&entry.task_key)?;
        validate_range(Some(&entry.start_date), Some(&entry.end_date))?;
    }
    Ok(saved.settings)
}
fn validate_color(color: &str) -> Result<()> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err("INVALID_COLOR: expected #RRGGBB".into());
    }
    Ok(())
}
fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = value[..4].parse().unwrap_or(0);
    let month: usize = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..].parse().unwrap_or(0);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    year > 0 && (1..=12).contains(&month) && day > 0 && day <= days[month - 1]
}
fn validate_range(start: Option<&str>, end: Option<&str>) -> Result<()> {
    match (start,end) {
        (None,None)=>Ok(()),
        (Some(start),Some(end)) if valid_date(start) && valid_date(end) && start <= end=>Ok(()),
        _=>Err("INVALID_DATE_RANGE: use valid YYYY-MM-DD dates with end on or after start, or two null dates".into()),
    }
}

#[derive(Default)]
pub struct CalendarCache {
    entries: VecDeque<(Instant, CalendarProject)>,
}
impl CalendarCache {
    pub fn remove(&mut self, project_id: &str) {
        self.entries
            .retain(|(_, project)| project.project_id != project_id);
    }
    pub fn get(&mut self, project_id: &str, force: bool) -> Option<CalendarProject> {
        let position = self
            .entries
            .iter()
            .position(|(_, project)| project.project_id == project_id)?;
        let (when, project) = self.entries.remove(position)?;
        if force || when.elapsed() >= Duration::from_secs(30) {
            return None;
        }
        self.entries.push_back((when, project.clone()));
        Some(project)
    }
    pub fn put(&mut self, project: CalendarProject) {
        self.entries
            .retain(|(_, old)| old.project_id != project.project_id);
        self.entries.push_back((Instant::now(), project));
        while self.entries.len() > 8 {
            self.entries.pop_front();
        }
    }
}
pub fn scan_project(project: &Project) -> Result<CalendarProject> {
    let mut index = Index::new(
        paths::tasks_root(project)?,
        project.id.clone(),
        "calendar".into(),
    );
    index.refresh(true, Default::default(), Default::default())?;
    Ok(CalendarProject {
        project_id: project.id.clone(),
        tasks: index.published.snapshot.tasks,
        diagnostics: index.published.snapshot.diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Project, Planner) {
        let source = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join(".trellis/tasks/09-12-task")).unwrap();
        fs::write(
            source.path().join(".trellis/tasks/09-12-task/task.json"),
            r#"{"id":"different-id","title":"Task","status":"planning"}"#,
        )
        .unwrap();
        let project = Project {
            id: "project".into(),
            name: "Project".into(),
            path: source.path().to_string_lossy().into(),
        };
        let planner = Planner::new(data.path().into());
        (source, data, project, planner)
    }
    fn input(id: Option<String>, key: &str) -> ScheduleUpdate {
        ScheduleUpdate {
            id,
            project_id: "project".into(),
            task_key: key.into(),
            start_date: Some("2024-02-29".into()),
            end_date: Some("2024-03-02".into()),
        }
    }
    #[test]
    fn dates_are_calendar_dates_and_colors_are_strict() {
        for date in [
            "2023-02-29",
            "1900-02-29",
            "2024-04-31",
            "2024-00-01",
            "0000-01-01",
            "2024-1-01",
            "2024-01-01T00:00Z",
            "💥-01-01",
        ] {
            assert!(!valid_date(date), "{date}");
        }
        for date in ["2000-02-29", "2024-02-29", "2024-12-31"] {
            assert!(valid_date(date));
        }
        assert!(validate_range(Some("2024-03-02"), Some("2024-03-01")).is_err());
        assert!(validate_range(Some("2024-03-02"), None).is_err());
        assert!(validate_range(None, None).is_ok());
        assert!(validate_color("#12aB90").is_ok());
        for color in ["red", "#fff", "#12345678", "#zzzzzz"] {
            assert!(validate_color(color).is_err());
        }
    }
    #[test]
    fn persists_own_settings_without_touching_imported_project() {
        let (source, data, project, mut planner) = fixture();
        let path = source.path().join(".trellis/tasks/09-12-task/task.json");
        let before = (
            fs::read(&path).unwrap(),
            fs::metadata(&path).unwrap().modified().unwrap(),
        );
        planner.color(project.id.clone(), "#aAbB12".into()).unwrap();
        let calendar = scan_project(&project).unwrap();
        let settings = planner
            .update(input(None, "09-12-task"), &project, &calendar)
            .unwrap();
        assert!(uuid::Uuid::parse_str(&settings.schedules[0].id).is_ok());
        let restored = Planner::new(data.path().into()).settings().unwrap();
        assert_eq!(restored.schedules[0].id, settings.schedules[0].id);
        assert_eq!(restored.schedules[0].start_date, "2024-02-29");
        assert_eq!(restored.project_colors["project"], "#aAbB12");
        assert_eq!(fs::read(&path).unwrap(), before.0);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before.1);
        assert_eq!(fs::read_dir(source.path()).unwrap().count(), 1);
    }
    #[test]
    fn corrupt_or_unknown_version_settings_are_never_overwritten() {
        for bytes in [
            "{",
            r#"{"schemaVersion":2,"projectColors":{},"schedules":[]}"#,
            r#"{"schemaVersion":1,"projectColors":{"project":"red"},"schedules":[]}"#,
        ] {
            let data = tempfile::tempdir().unwrap();
            fs::write(data.path().join("planner.json"), bytes).unwrap();
            let mut planner = Planner::new(data.path().into());
            assert!(planner.settings().is_err());
            assert!(planner.color("project".into(), "#123456".into()).is_err());
            assert_eq!(
                fs::read_to_string(data.path().join("planner.json")).unwrap(),
                bytes
            );
        }
    }
    #[test]
    fn failed_atomic_replace_preserves_memory_and_removes_temporary_file() {
        let (_source, data, project, mut planner) = fixture();
        planner.color(project.id.clone(), "#123456".into()).unwrap();
        let saved = fs::read(data.path().join("planner.json")).unwrap();
        fs::rename(
            data.path().join("planner.json"),
            data.path().join("original.json"),
        )
        .unwrap();
        fs::create_dir(data.path().join("planner.json")).unwrap();
        assert!(planner.color(project.id, "#abcdef".into()).is_err());
        assert_eq!(
            planner.settings().unwrap().project_colors["project"],
            "#123456"
        );
        assert_eq!(fs::read(data.path().join("original.json")).unwrap(), saved);
        assert_eq!(fs::read_dir(data.path()).unwrap().count(), 2);
    }
    #[test]
    fn archive_move_keeps_uuid_but_rejects_ambiguous_or_still_existing_source() {
        let (source, _data, project, mut planner) = fixture();
        let calendar = scan_project(&project).unwrap();
        let id = planner
            .update(input(None, "09-12-task"), &project, &calendar)
            .unwrap()
            .schedules[0]
            .id
            .clone();
        let root = source.path().join(".trellis/tasks");
        fs::create_dir_all(root.join("archive/2024-03/09-12-task")).unwrap();
        fs::copy(
            root.join("09-12-task/task.json"),
            root.join("archive/2024-03/09-12-task/task.json"),
        )
        .unwrap();
        let moved_key = "archive/2024-03/09-12-task";
        assert!(planner
            .update(
                input(Some(id.clone()), moved_key),
                &project,
                &scan_project(&project).unwrap()
            )
            .is_err());
        fs::remove_dir_all(root.join("09-12-task")).unwrap();
        fs::create_dir_all(root.join("archive/2024-04/09-12-task")).unwrap();
        fs::copy(
            root.join(moved_key).join("task.json"),
            root.join("archive/2024-04/09-12-task/task.json"),
        )
        .unwrap();
        assert!(planner
            .update(
                input(Some(id.clone()), moved_key),
                &project,
                &scan_project(&project).unwrap()
            )
            .is_err());
        assert_eq!(
            planner.settings().unwrap().schedules[0].task_key,
            "09-12-task"
        );
        fs::remove_dir_all(root.join("archive/2024-04")).unwrap();
        let moved = planner
            .update(
                input(Some(id.clone()), moved_key),
                &project,
                &scan_project(&project).unwrap(),
            )
            .unwrap();
        assert_eq!(moved.schedules[0].id, id);
        assert_eq!(moved.schedules[0].task_key, moved_key);
    }
    #[test]
    fn cancellation_and_project_boundaries_and_missing_history_clear() {
        let (_source, _data, project, mut planner) = fixture();
        let mut calendar = scan_project(&project).unwrap();
        calendar.tasks[0].status = "cancelled".into();
        assert!(planner
            .update(input(None, "09-12-task"), &project, &calendar)
            .is_err());
        calendar.tasks[0].status = "completed".into();
        let id = planner
            .update(input(None, "09-12-task"), &project, &calendar)
            .unwrap()
            .schedules[0]
            .id
            .clone();
        let mut clear = input(Some(id), "missing-old-path");
        clear.start_date = None;
        clear.end_date = None;
        clear.project_id = "other-project".into();
        assert!(planner.clear(&clear).is_err());
        clear.project_id = project.id;
        assert!(planner.clear(&clear).unwrap().schedules.is_empty());
    }
    #[test]
    fn schedules_parents_and_children_and_preserves_source_files() {
        let (source, _data, project, mut planner) = fixture();
        let original = planner
            .update(
                input(None, "09-12-task"),
                &project,
                &scan_project(&project).unwrap(),
            )
            .unwrap();
        let root = source.path().join(".trellis/tasks");
        fs::create_dir(root.join("parent")).unwrap();
        let parent =
            r#"{"id":"parent","title":"Parent","status":"in_progress","children":["09-12-task"]}"#;
        let child = r#"{"id":"child","title":"Child","status":"planning","parent":"parent"}"#;
        fs::write(root.join("parent/task.json"), parent).unwrap();
        fs::write(root.join("09-12-task/task.json"), child).unwrap();
        let calendar = scan_project(&project).unwrap();
        assert_eq!(
            calendar
                .tasks
                .iter()
                .find(|task| task.key == "parent")
                .unwrap()
                .child_keys,
            vec!["09-12-task"]
        );
        let mut moved = input(Some(original.schedules[0].id.clone()), "09-12-task");
        moved.start_date = Some("2024-03-01".into());
        moved.end_date = Some("2024-03-04".into());
        let changed = planner.update(moved, &project, &calendar).unwrap();
        assert_eq!(changed.schedules[0].start_date, "2024-03-01");
        assert_eq!(changed.schedules[0].end_date, "2024-03-04");
        let saved = planner
            .update(input(None, "parent"), &project, &calendar)
            .unwrap();
        assert_eq!(saved.schedules.len(), 2);
        assert!(saved
            .schedules
            .iter()
            .any(|entry| entry.task_key == "parent"));
        let mut clear = input(Some(original.schedules[0].id.clone()), "09-12-task");
        clear.start_date = None;
        clear.end_date = None;
        let saved = planner.clear(&clear).unwrap();
        assert_eq!(saved.schedules.len(), 1);
        assert_eq!(saved.schedules[0].task_key, "parent");
        let recreated = planner
            .update(input(None, "09-12-task"), &project, &calendar)
            .unwrap();
        assert_eq!(recreated.schedules.len(), 2);
        assert_ne!(recreated.schedules[1].id, original.schedules[0].id);
        assert_eq!(
            fs::read_to_string(root.join("parent/task.json")).unwrap(),
            parent
        );
        assert_eq!(
            fs::read_to_string(root.join("09-12-task/task.json")).unwrap(),
            child
        );
    }
    #[test]
    fn calendar_cache_is_bounded_expires_and_can_be_forced() {
        let mut cache = CalendarCache::default();
        for i in 0..10 {
            cache.put(CalendarProject {
                project_id: i.to_string(),
                tasks: vec![],
                diagnostics: vec![],
            });
        }
        assert_eq!(cache.entries.len(), 8);
        assert!(cache.get("0", false).is_none());
        assert!(cache.get("9", false).is_some());
        assert!(cache.get("9", true).is_none());
        cache.entries.front_mut().unwrap().0 = Instant::now() - Duration::from_secs(31);
        assert!(cache.get("2", false).is_none());
    }
}
