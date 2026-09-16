use crate::{
    contracts::TaskSummary,
    paths::{contained, io, key_from_path, Result},
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::Path,
};

#[derive(Clone, Debug)]
pub struct RawTask {
    pub summary: TaskSummary,
    pub id: Option<String>,
    pub name: Option<String>,
    pub parent: Option<String>,
    pub children: Vec<String>,
}
impl RawTask {
    pub fn same_relationships(&self, other: &Self) -> bool {
        self.id == other.id
            && self.name == other.name
            && self.parent == other.parent
            && self.children == other.children
    }
}
pub fn read_task(root: &Path, key: &str) -> Result<RawTask> {
    let path = contained(root, &format!("{key}/task.json"))?;
    let bytes = fs::read(path).map_err(io)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("INVALID_METADATA {key}: {e}"))?;
    if !value.is_object() {
        return Err(format!("INVALID_METADATA {key}: expected JSON object"));
    }
    let string = |field: &str| {
        value
            .get(field)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    let name = string("name");
    let title = string("title")
        .or_else(|| name.clone())
        .unwrap_or_else(|| key.rsplit('/').next().unwrap_or(key).into());
    let archived = key.starts_with("archive/");
    // Archive location and completion are independent: keep the recorded status.
    let status = match string("status").as_deref() {
        Some("done") => "completed".into(),
        Some(s) => s.into(),
        None => "unknown".into(),
    };
    let children = value
        .get("children")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(RawTask {
        summary: TaskSummary {
            key: key.into(),
            title,
            status,
            relative_dir: key.into(),
            parent_key: None,
            child_keys: vec![],
            archived,
            revision: blake3::hash(&bytes).to_hex().to_string(),
        },
        id: string("id"),
        name,
        parent: string("parent"),
        children,
    })
}

pub fn enumerate_keys(root: &Path) -> Result<BTreeSet<String>> {
    let mut keys = BTreeSet::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).map_err(io)? {
            let entry = entry.map_err(io)?;
            let path = entry.path();
            // Enumerate supported active and archive depths only; never descend task documents.
            let relative = key_from_path(path.strip_prefix(root).map_err(|e| e.to_string())?);
            let Ok(actual) = path.canonicalize() else {
                continue;
            };
            if !actual.starts_with(root) || !actual.is_dir() {
                continue;
            }
            if actual.join("task.json").is_file() {
                keys.insert(relative.clone());
            }
            if relative == "archive"
                || (relative.starts_with("archive/") && relative.matches('/').count() == 1)
            {
                directories.push(path);
            }
        }
    }
    Ok(keys)
}

pub fn resolve(tasks: &BTreeMap<String, RawTask>) -> (BTreeMap<String, TaskSummary>, Vec<String>) {
    let mut directories: HashMap<String, Vec<String>> = HashMap::new();
    let mut aliases: HashMap<String, BTreeSet<String>> = HashMap::new();
    for (key, task) in tasks {
        directories
            .entry(key.rsplit('/').next().unwrap_or(key).into())
            .or_default()
            .push(key.clone());
        for alias in [&task.id, &task.name].into_iter().flatten() {
            aliases
                .entry(alias.clone())
                .or_default()
                .insert(key.clone());
        }
    }
    let lookup = |reference: &str| -> Option<String> {
        let reference = reference
            .strip_prefix(".trellis/tasks/")
            .unwrap_or(reference);
        if tasks.contains_key(reference) {
            return Some(reference.into());
        }
        if let Some(keys) = directories.get(reference) {
            return (keys.len() == 1).then(|| keys[0].clone());
        }
        aliases
            .get(reference)
            .filter(|set| set.len() == 1)
            .and_then(|set| set.first().cloned())
    };
    let mut diagnostics = Vec::new();
    let mut parents: BTreeMap<String, String> = BTreeMap::new();
    let mut candidates: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (key, task) in tasks {
        if let Some(reference) = &task.parent {
            match lookup(reference) {
                Some(parent) if parent != *key => {
                    parents.insert(key.clone(), parent);
                }
                _ => diagnostics.push(format!(
                    "{key}: unresolved, ambiguous or self parent {reference}"
                )),
            }
        }
        for reference in &task.children {
            if let Some(child) = lookup(reference) {
                if child == *key {
                    diagnostics.push(format!("{key}: ignored self child"));
                    continue;
                }
                let child_task = &tasks[&child];
                if let Some(explicit_parent) = &child_task.parent {
                    if lookup(explicit_parent).as_deref() != Some(key) {
                        diagnostics.push(format!(
                            "{key}: child {child} has conflicting explicit parent"
                        ));
                    }
                } else if !task.summary.archived || child_task.summary.archived {
                    candidates.entry(child).or_default().insert(key.clone());
                }
                // Archived parent's historical-only live children remain roots in P0.
            } else {
                diagnostics.push(format!("{key}: unresolved or ambiguous child {reference}"));
            }
        }
    }
    for (child, choices) in candidates {
        if choices.len() == 1 {
            parents.insert(child, choices.first().unwrap().clone());
        } else {
            diagnostics.push(format!("{child}: multiple candidate parents"));
        }
    }
    // Each node has at most one owner. Linear walk and deterministic edge removal make all nodes reachable.
    let mut done = HashSet::new();
    for key in tasks.keys() {
        let mut chain = Vec::new();
        let mut positions = HashMap::new();
        let mut cursor = key.clone();
        while !done.contains(&cursor) {
            if let Some(&start) = positions.get(&cursor) {
                let broken = chain[start..].iter().min().cloned().unwrap();
                parents.remove(&broken);
                diagnostics.push(format!("{broken}: parent cycle broken for display"));
                break;
            }
            positions.insert(cursor.clone(), chain.len());
            chain.push(cursor.clone());
            match parents.get(&cursor) {
                Some(parent) => cursor = parent.clone(),
                None => break,
            }
        }
        done.extend(chain);
    }
    let mut summaries: BTreeMap<_, _> = tasks
        .iter()
        .map(|(key, task)| (key.clone(), task.summary.clone()))
        .collect();
    for (child, parent) in parents {
        summaries.get_mut(&child).unwrap().parent_key = Some(parent.clone());
        summaries.get_mut(&parent).unwrap().child_keys.push(child);
    }
    (summaries, diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task(key: &str, data: &str) -> RawTask {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(key)).unwrap();
        fs::write(dir.path().join(key).join("task.json"), data).unwrap();
        read_task(&dir.path().canonicalize().unwrap(), key).unwrap()
    }
    #[test]
    fn archive_retains_completion_without_assuming_all_archived_tasks_are_done() {
        for (recorded, expected) in [
            ("completed", "completed"),
            ("done", "completed"),
            ("planning", "planning"),
        ] {
            let archived = task(
                "archive/2026-09/task",
                &format!(r#"{{"status":"{recorded}"}}"#),
            );
            assert!(archived.summary.archived);
            assert_eq!(archived.summary.status, expected);
        }
    }
    #[test]
    fn enumerates_archive_keys_with_portable_separators() {
        let dir = tempfile::tempdir().unwrap();
        let task = dir.path().join("archive/2024-03/task");
        fs::create_dir_all(&task).unwrap();
        fs::write(task.join("task.json"), "{}").unwrap();
        assert!(enumerate_keys(&dir.path().canonicalize().unwrap())
            .unwrap()
            .contains("archive/2024-03/task"));
    }
    #[test]
    fn resolves_directory_before_id_and_preserves_duplicate_ids() {
        let tasks = BTreeMap::from([
            (
                "09-11-parent".into(),
                task("09-11-parent", r#"{"id":"parent","children":["child"]}"#),
            ),
            (
                "09-11-child".into(),
                task("09-11-child", r#"{"id":"child","parent":"09-11-parent"}"#),
            ),
            ("duplicate".into(), task("duplicate", r#"{"id":"child"}"#)),
        ]);
        let (rows, diagnostics) = resolve(&tasks);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows["09-11-child"].parent_key.as_deref(),
            Some("09-11-parent")
        );
        assert!(rows["duplicate"].parent_key.is_none());
        assert!(!diagnostics.is_empty());
    }
    #[test]
    fn archive_does_not_steal_live_root_and_cycles_remain_reachable() {
        let tasks = BTreeMap::from([
            (
                "archive/2026-09/parent".into(),
                task(
                    "archive/2026-09/parent",
                    r#"{"id":"parent","children":["live"]}"#,
                ),
            ),
            ("live".into(), task("live", r#"{"parent":null}"#)),
            ("a".into(), task("a", r#"{"parent":"b"}"#)),
            ("b".into(), task("b", r#"{"parent":"a"}"#)),
        ]);
        let (rows, _) = resolve(&tasks);
        assert!(rows["live"].parent_key.is_none());
        assert!(rows["a"].parent_key.is_none());
        assert_eq!(rows["b"].parent_key.as_deref(), Some("a"));
        assert!(rows["archive/2026-09/parent"].archived);
        assert_eq!(rows["archive/2026-09/parent"].status, "unknown");
    }
}
