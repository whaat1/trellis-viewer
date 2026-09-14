use crate::{
    contracts::{Invalidated, Project},
    index::{Index, Published},
    paths::{self, Result},
};
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind},
    Event, EventKind, RecursiveMode, Watcher,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchMetric {
    pub elapsed_ms: f64,
    pub full_scan: bool,
    pub dirty_tasks: usize,
    pub document_tasks: usize,
    pub upserts: usize,
    pub payload_bytes: usize,
}

pub struct Active {
    pub project: Project,
    pub published: Arc<RwLock<Published>>,
    pub stopped: Arc<AtomicBool>,
    pub metrics: Arc<Mutex<Vec<BatchMetric>>>,
}
impl Drop for Active {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

pub fn start(project: Project, epoch: String, app: tauri::AppHandle) -> Result<Active> {
    let root = paths::tasks_root(&project)?;
    let (tx, rx) = mpsc::sync_channel(2048);
    let overflow = Arc::new(AtomicBool::new(false));
    let dropped = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if tx.try_send(event).is_err() {
            dropped.store(true, Ordering::Release);
        }
    })
    .map_err(|e| format!("WATCH_ERROR: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("WATCH_ERROR: {e}"))?;
    let lexical_parent = PathBuf::from(&project.path).join(".trellis");
    watcher
        .watch(&lexical_parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("WATCH_ERROR: {e}"))?;
    let mut index = Index::new(root.clone(), project.id.clone(), epoch);
    index.refresh(true, Default::default(), Default::default())?;
    let published = Arc::new(RwLock::new(index.published.clone()));
    let stopped = Arc::new(AtomicBool::new(false));
    let cancellation = stopped.clone();
    let metrics = Arc::new(Mutex::new(Vec::new()));
    let batch_metrics = metrics.clone();
    let output = published.clone();
    let watched_project = project.clone();
    std::thread::Builder::new()
        .name("trellis-index".into())
        .spawn(move || {
            let mut last_reconcile = Instant::now();
            while !cancellation.load(Ordering::Acquire) {
                let batch = receive_batch(&rx, &overflow);
                let due = last_reconcile.elapsed() >= Duration::from_secs(60);
                if batch.events.is_empty() && !batch.full && !due {
                    continue;
                }
                let started = Instant::now();
                let mut full = batch.full || due;
                let mut dirty = BTreeSet::new();
                let mut docs = BTreeSet::new();
                for event in batch.events {
                    if matches!(event.kind, EventKind::Access(_)) {
                        continue;
                    }
                    for path in &event.paths {
                        if let Some(key) = index.task_for_event(path) {
                            let file = path.file_name().and_then(|p| p.to_str()).unwrap_or("");
                            if file == "task.json" {
                                dirty.insert(key.clone());
                                if !path.exists() {
                                    full = true;
                                }
                            } else if path
                                .extension()
                                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
                            {
                                docs.insert(key.clone());
                            } else if directory_change(&event.kind, path) {
                                docs.insert(key);
                                full = true;
                            }
                        } else {
                            full = true;
                        }
                    }
                }
                if full {
                    // Infrequent reconciliation also invalidates open documents, covering missed content events.
                    docs.extend(index.raw.keys().cloned());
                    if let Ok(next_root) = paths::tasks_root(&watched_project) {
                        // Re-register on parent notifications too: atomic directory replacement may reuse the path.
                        let _ = watcher.unwatch(&index.root);
                        index.root = next_root;
                        if watcher
                            .watch(&index.root, RecursiveMode::Recursive)
                            .is_err()
                        {
                            overflow.store(true, Ordering::Release);
                        }
                    }
                }
                let counts = (dirty.len(), docs.len());
                match index.refresh(full, dirty, docs) {
                    Ok(Some(patch)) => {
                        if cancellation.load(Ordering::Acquire) {
                            break;
                        }
                        if let Ok(mut shared) = output.write() {
                            shared.mirror(&index.published.snapshot, patch.clone());
                        }
                        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                        if let Ok(mut log) = batch_metrics.lock() {
                            if log.len() >= 300 {
                                log.remove(0);
                            }
                            log.push(BatchMetric {
                                elapsed_ms,
                                full_scan: full,
                                dirty_tasks: counts.0,
                                document_tasks: counts.1,
                                upserts: patch.upserts.len(),
                                payload_bytes: serde_json::to_vec(&patch).map_or(0, |v| v.len()),
                            });
                        }
                        let _ = app.emit(
                            "project-invalidated",
                            Invalidated {
                                project_id: patch.project_id,
                                epoch: patch.epoch,
                                revision: patch.revision,
                            },
                        );
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let snapshot = &mut index.published.snapshot;
                        if !snapshot.diagnostics.contains(&error) {
                            snapshot.diagnostics.push(error);
                            snapshot.revision += 1;
                            let patch = crate::contracts::Changes {
                                project_id: snapshot.project_id.clone(),
                                epoch: snapshot.epoch.clone(),
                                base_revision: snapshot.revision - 1,
                                revision: snapshot.revision,
                                reset_required: false,
                                upserts: vec![],
                                removed: vec![],
                                root_keys: None,
                                document_task_keys: vec![],
                                diagnostics: snapshot.diagnostics.clone(),
                            };
                            if let Ok(mut shared) = output.write() {
                                shared.mirror(snapshot, patch);
                            }
                            let _ = app.emit(
                                "project-invalidated",
                                Invalidated {
                                    project_id: snapshot.project_id.clone(),
                                    epoch: snapshot.epoch.clone(),
                                    revision: snapshot.revision,
                                },
                            );
                        }
                    }
                }
                if full {
                    last_reconcile = Instant::now();
                }
            }
            drop(watcher);
        })
        .map_err(paths::io)?;
    Ok(Active {
        project,
        published,
        stopped,
        metrics,
    })
}

// Folder names may contain periods. In remove/rename events the old path may
// already be gone; unknown non-document paths must trigger reconciliation.
fn directory_change(kind: &EventKind, path: &std::path::Path) -> bool {
    matches!(
        kind,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
    ) || path.is_dir()
        || path.extension().is_none()
        || (matches!(
            kind,
            EventKind::Modify(ModifyKind::Name(_))
                | EventKind::Remove(RemoveKind::Any)
                | EventKind::Any
        ) && !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json") || ext.eq_ignore_ascii_case("tmp")))
}

struct Batch {
    events: Vec<Event>,
    full: bool,
}
fn receive_batch(rx: &Receiver<notify::Result<Event>>, overflow: &AtomicBool) -> Batch {
    let mut batch = Batch {
        events: vec![],
        full: overflow.swap(false, Ordering::AcqRel),
    };
    let first = rx.recv_timeout(Duration::from_millis(100));
    match first {
        Ok(Ok(event)) => {
            batch.full |= event.need_rescan();
            batch.events.push(event);
        }
        Ok(Err(_)) => batch.full = true,
        Err(_) => return batch,
    }
    let start = Instant::now();
    loop {
        let remaining = Duration::from_millis(500).saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(180).min(remaining)) {
            Ok(Ok(event)) => {
                batch.full |= event.need_rescan();
                if batch.events.len() < 2048 {
                    batch.events.push(event);
                } else {
                    batch.full = true;
                }
            }
            Ok(Err(_)) => batch.full = true,
            Err(_) => break,
        }
    }
    batch.full |= overflow.swap(false, Ordering::AcqRel);
    batch
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dropped_native_events_require_reconciliation_even_without_paths() {
        let (tx, rx) = mpsc::sync_channel(4);
        tx.send(Ok(
            Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan)
        ))
        .unwrap();
        drop(tx);
        assert!(receive_batch(&rx, &AtomicBool::new(false)).full);
    }
    #[test]
    fn dotted_removed_and_renamed_folders_invalidate_documents() {
        let path = std::path::Path::new("/missing/research.v1");
        assert!(directory_change(
            &EventKind::Remove(RemoveKind::Folder),
            path
        ));
        assert!(directory_change(
            &EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::From)),
            path
        ));
        assert!(!directory_change(
            &EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::From)),
            std::path::Path::new("/missing/task.json.tmp")
        ));
    }
    #[test]
    fn continuous_events_commit_within_half_second_window() {
        let (tx, rx) = mpsc::sync_channel(2048);
        let producer = std::thread::spawn(move || {
            for _ in 0..150 {
                if tx.send(Ok(Event::new(EventKind::Any))).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let start = Instant::now();
        let batch = receive_batch(&rx, &AtomicBool::new(false));
        assert!(!batch.events.is_empty());
        assert!(start.elapsed() < Duration::from_millis(800));
        drop(rx);
        producer.join().unwrap();
    }
}
