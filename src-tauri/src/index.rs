use crate::{
    contracts::{Changes, Snapshot, TaskSummary},
    domain::{self, RawTask},
    paths::Result,
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    time::Instant,
};

const HISTORY_LIMIT: usize = 128;
const HISTORY_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub struct Published {
    pub snapshot: Snapshot,
    history: VecDeque<Changes>,
    history_bytes: usize,
}
impl Published {
    pub fn changes(&self, since: u64) -> Changes {
        let mut result = Changes {
            project_id: self.snapshot.project_id.clone(),
            epoch: self.snapshot.epoch.clone(),
            base_revision: since,
            revision: self.snapshot.revision,
            reset_required: false,
            upserts: vec![],
            removed: vec![],
            root_keys: None,
            document_task_keys: vec![],
            diagnostics: self.snapshot.diagnostics.clone(),
        };
        if since == self.snapshot.revision {
            return result;
        }
        if since > self.snapshot.revision
            || self.history.front().is_none_or(|c| since < c.base_revision)
        {
            result.reset_required = true;
            return result;
        }
        let mut upserts = BTreeMap::new();
        let mut removed = BTreeSet::new();
        let mut docs = BTreeSet::new();
        for patch in self.history.iter().filter(|c| c.revision > since) {
            for row in &patch.upserts {
                removed.remove(&row.key);
                upserts.insert(row.key.clone(), row.clone());
            }
            for key in &patch.removed {
                upserts.remove(key);
                removed.insert(key.clone());
            }
            if patch.root_keys.is_some() {
                result.root_keys = patch.root_keys.clone();
            }
            docs.extend(patch.document_task_keys.iter().cloned());
        }
        result.upserts = upserts.into_values().collect();
        result.removed = removed.into_iter().collect();
        result.document_task_keys = docs.into_iter().collect();
        result
    }
    pub fn mirror(&mut self, snapshot: &Snapshot, patch: Changes) {
        if !patch.upserts.is_empty() || !patch.removed.is_empty() {
            self.snapshot.tasks = snapshot.tasks.clone();
        }
        self.snapshot.revision = snapshot.revision;
        self.snapshot.scan_ms = snapshot.scan_ms;
        self.snapshot.diagnostics = snapshot.diagnostics.clone();
        if let Some(roots) = &patch.root_keys {
            self.snapshot.root_keys = roots.clone();
        }
        self.push_history(patch);
    }
    fn push_history(&mut self, patch: Changes) {
        self.history_bytes += serde_json::to_vec(&patch).map_or(0, |v| v.len());
        self.history.push_back(patch);
        while self.history.len() > HISTORY_LIMIT || self.history_bytes > HISTORY_BYTES {
            if let Some(old) = self.history.pop_front() {
                self.history_bytes = self
                    .history_bytes
                    .saturating_sub(serde_json::to_vec(&old).map_or(0, |v| v.len()));
            }
        }
    }
    pub fn commit(&mut self, patch: Changes, rows: &BTreeMap<String, TaskSummary>, scan_ms: f64) {
        self.snapshot.revision = patch.revision;
        // The full vector is materialized once per metadata batch, never on a Markdown-only change.
        if !patch.upserts.is_empty() || !patch.removed.is_empty() {
            self.snapshot.tasks = rows.values().cloned().collect();
        }
        if let Some(roots) = &patch.root_keys {
            self.snapshot.root_keys = roots.clone();
        }
        self.snapshot.scan_ms = scan_ms;
        self.snapshot.diagnostics = patch.diagnostics.clone();
        self.push_history(patch);
    }
}

pub struct Index {
    pub root: PathBuf,
    pub raw: BTreeMap<String, RawTask>,
    rows: BTreeMap<String, TaskSummary>,
    relation_diagnostics: Vec<String>,
    metadata_errors: BTreeMap<String, String>,
    pub published: Published,
}
impl Index {
    pub fn new(root: PathBuf, project_id: String, epoch: String) -> Self {
        let snapshot = Snapshot {
            project_id,
            epoch,
            revision: 0,
            tasks: vec![],
            root_keys: vec![],
            scan_ms: 0.0,
            diagnostics: vec![],
        };
        Self {
            root,
            raw: BTreeMap::new(),
            rows: BTreeMap::new(),
            relation_diagnostics: vec![],
            metadata_errors: BTreeMap::new(),
            published: Published {
                snapshot,
                history: VecDeque::new(),
                history_bytes: 0,
            },
        }
    }
    pub fn refresh(
        &mut self,
        full: bool,
        dirty: BTreeSet<String>,
        mut docs: BTreeSet<String>,
    ) -> Result<Option<Changes>> {
        let start = Instant::now();
        let mut metadata_changed = BTreeSet::new();
        let mut removed = Vec::new();
        let mut relation_changed = false;
        let mut diagnostics = Vec::new();
        let keys = if full {
            domain::enumerate_keys(&self.root)?
        } else {
            dirty
        };
        if full {
            for key in self
                .raw
                .keys()
                .filter(|key| !keys.contains(*key))
                .cloned()
                .collect::<Vec<_>>()
            {
                self.raw.remove(&key);
                self.metadata_errors.remove(&key);
                self.rows.remove(&key);
                removed.push(key.clone());
                docs.insert(key);
                relation_changed = true;
            }
        }
        for key in keys {
            match domain::read_task(&self.root, &key) {
                Ok(raw) => {
                    self.metadata_errors.remove(&key);
                    if self
                        .raw
                        .get(&key)
                        .is_none_or(|old| old.summary.revision != raw.summary.revision)
                    {
                        relation_changed |= self
                            .raw
                            .get(&key)
                            .is_none_or(|old| !old.same_relationships(&raw));
                        metadata_changed.insert(key.clone());
                        self.raw.insert(key, raw);
                    }
                }
                Err(e) => {
                    // A partial/atomic save retains the last valid row; the next event or reconciliation retries.
                    self.metadata_errors.insert(key.clone(), e);
                    if !self.raw.contains_key(&key) {
                        let archived = key.starts_with("archive/");
                        self.raw.insert(
                            key.clone(),
                            RawTask {
                                summary: TaskSummary {
                                    key: key.clone(),
                                    relative_dir: key.clone(),
                                    title: format!(
                                        "{} (metadata unavailable)",
                                        key.rsplit('/').next().unwrap_or(&key)
                                    ),
                                    status: if archived { "archived" } else { "unknown" }.into(),
                                    parent_key: None,
                                    child_keys: vec![],
                                    archived,
                                    revision: "unavailable".into(),
                                },
                                id: None,
                                name: None,
                                parent: None,
                                children: vec![],
                            },
                        );
                        relation_changed = true;
                    }
                }
            }
        }
        let mut upserts = Vec::new();
        if relation_changed {
            let (next, issues) = domain::resolve(&self.raw);
            self.relation_diagnostics = issues;
            for (key, row) in &next {
                if self.rows.get(key) != Some(row) {
                    upserts.push(row.clone());
                }
            }
            self.rows = next;
        } else {
            for key in metadata_changed {
                let mut row = self.raw[&key].summary.clone();
                if let Some(old) = self.rows.get(&key) {
                    row.parent_key = old.parent_key.clone();
                    row.child_keys = old.child_keys.clone();
                }
                self.rows.insert(key, row.clone());
                upserts.push(row);
            }
        }
        diagnostics.extend(self.relation_diagnostics.iter().cloned());
        diagnostics.extend(self.metadata_errors.values().cloned());
        let root_keys = if relation_changed || self.published.snapshot.revision == 0 {
            let roots: Vec<_> = self
                .rows
                .values()
                .filter(|row| row.parent_key.is_none())
                .map(|row| row.key.clone())
                .collect();
            (roots != self.published.snapshot.root_keys || self.published.snapshot.revision == 0)
                .then_some(roots)
        } else {
            None
        };
        if self.published.snapshot.revision > 0
            && upserts.is_empty()
            && removed.is_empty()
            && docs.is_empty()
            && diagnostics == self.published.snapshot.diagnostics
        {
            return Ok(None);
        }
        let patch = Changes {
            project_id: self.published.snapshot.project_id.clone(),
            epoch: self.published.snapshot.epoch.clone(),
            base_revision: self.published.snapshot.revision,
            revision: self.published.snapshot.revision + 1,
            reset_required: false,
            upserts,
            removed,
            root_keys,
            document_task_keys: docs.into_iter().collect(),
            diagnostics,
        };
        self.published.commit(
            patch.clone(),
            &self.rows,
            start.elapsed().as_secs_f64() * 1000.0,
        );
        Ok(Some(patch))
    }
    pub fn task_for_event(&self, path: &std::path::Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        let parts: Vec<_> = relative.iter().collect();
        let n = if parts.first().is_some_and(|p| *p == "archive") {
            3
        } else {
            1
        };
        if parts.len() < n {
            return None;
        }
        Some(
            parts[..n]
                .iter()
                .collect::<PathBuf>()
                .to_string_lossy()
                .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn fixture() -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("one")).unwrap();
        fs::write(
            dir.path().join("one/task.json"),
            r#"{"title":"One","status":"planning"}"#,
        )
        .unwrap();
        let mut index = Index::new(
            dir.path().canonicalize().unwrap(),
            "project".into(),
            "epoch".into(),
        );
        index
            .refresh(true, Default::default(), Default::default())
            .unwrap();
        (dir, index)
    }
    #[test]
    fn document_only_update_advances_revision_without_metadata_or_root_patch() {
        let (_dir, mut index) = fixture();
        let before = index.published.snapshot.revision;
        index
            .refresh(false, Default::default(), BTreeSet::from(["one".into()]))
            .unwrap();
        let patch = index.published.changes(before);
        assert_eq!(patch.revision, before + 1);
        assert!(patch.upserts.is_empty());
        assert!(patch.root_keys.is_none());
        assert_eq!(patch.document_task_keys, ["one"]);
    }
    #[test]
    fn history_gap_requires_reset_and_atomic_save_keeps_last_valid_row() {
        let (dir, mut index) = fixture();
        fs::write(dir.path().join("one/task.json"), "{").unwrap();
        index
            .refresh(false, BTreeSet::from(["one".into()]), Default::default())
            .unwrap();
        assert_eq!(index.published.snapshot.tasks[0].title, "One");
        assert!(!index.published.snapshot.diagnostics.is_empty());
        for _ in 0..130 {
            index
                .refresh(false, Default::default(), BTreeSet::from(["one".into()]))
                .unwrap();
        }
        assert!(index.published.changes(1).reset_required);
        assert!(
            !index
                .published
                .changes(index.published.snapshot.revision - 1)
                .reset_required
        );
    }
    #[test]
    fn aggregated_patch_removes_deleted_task_and_retains_doc_invalidation() {
        let (dir, mut index) = fixture();
        let before = index.published.snapshot.revision;
        index
            .refresh(false, Default::default(), BTreeSet::from(["one".into()]))
            .unwrap();
        fs::remove_dir_all(dir.path().join("one")).unwrap();
        index
            .refresh(true, Default::default(), Default::default())
            .unwrap();
        let patch = index.published.changes(before);
        assert_eq!(patch.removed, ["one"]);
        assert!(patch.upserts.is_empty());
        assert_eq!(patch.root_keys, Some(vec![]));
        assert_eq!(patch.document_task_keys, ["one"]);
    }

    #[test]
    fn unrelated_metadata_is_not_read_by_document_or_targeted_updates() {
        let (dir, mut index) = fixture();
        fs::create_dir(dir.path().join("two")).unwrap();
        fs::write(dir.path().join("two/task.json"), r#"{"title":"Two"}"#).unwrap();
        index
            .refresh(true, Default::default(), Default::default())
            .unwrap();
        fs::write(dir.path().join("two/task.json"), "{").unwrap();
        fs::write(
            dir.path().join("one/task.json"),
            r#"{"title":"Updated","status":"in_progress"}"#,
        )
        .unwrap();
        let before = index.published.snapshot.revision;
        index
            .refresh(
                false,
                BTreeSet::from(["one".into()]),
                BTreeSet::from(["two".into()]),
            )
            .unwrap();
        let patch = index.published.changes(before);
        assert!(patch.diagnostics.is_empty());
        assert_eq!(patch.upserts.len(), 1);
        assert_eq!(patch.upserts[0].title, "Updated");
        assert!(patch.root_keys.is_none());
        assert_eq!(index.published.snapshot.tasks[1].title, "Two");
    }

    #[test]
    fn initially_corrupt_task_remains_visible_until_repaired() {
        let (dir, mut index) = fixture();
        fs::create_dir(dir.path().join("broken")).unwrap();
        fs::write(dir.path().join("broken/task.json"), "{").unwrap();
        index
            .refresh(true, Default::default(), Default::default())
            .unwrap();
        assert_eq!(index.published.snapshot.tasks.len(), 2);
        assert_eq!(index.rows["broken"].status, "unknown");
        index
            .refresh(false, Default::default(), BTreeSet::from(["one".into()]))
            .unwrap();
        assert!(!index.published.snapshot.diagnostics.is_empty());
        fs::write(
            dir.path().join("broken/task.json"),
            r#"{"title":"Repaired"}"#,
        )
        .unwrap();
        index
            .refresh(false, BTreeSet::from(["broken".into()]), Default::default())
            .unwrap();
        assert_eq!(index.rows["broken"].title, "Repaired");
        assert!(index.published.snapshot.diagnostics.is_empty());
    }
}
