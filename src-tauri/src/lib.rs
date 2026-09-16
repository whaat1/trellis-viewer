pub mod contracts;
mod domain;
mod index;
mod paths;
mod planner;
mod service;
mod storage;

use contracts::{
    Bootstrap, CalendarProject, Changes, DocEntry, Document, PlannerSettings, Project,
    ScheduleUpdate, Snapshot,
};
use paths::Result;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

struct AppState {
    epoch: String,
    storage: Mutex<storage::Storage>,
    planner: Mutex<planner::Planner>,
    calendar_cache: Mutex<planner::CalendarCache>,
    calendar_scan: Mutex<()>,
    active: Mutex<Option<service::Active>>,
    generation: AtomicU64,
    activation_lock: Mutex<()>,
}
fn poisoned<T>(_: std::sync::PoisonError<T>) -> String {
    "INTERNAL_ERROR: state lock unavailable".into()
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("INTERNAL_ERROR: {e}"))?
}
fn perf_option(value: Option<&str>, range: std::ops::RangeInclusive<u32>, default: u32) -> u32 {
    value
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| range.contains(value))
        .unwrap_or(default)
}

#[cfg(test)]
mod perf_option_tests {
    use super::perf_option;
    #[test]
    fn benchmark_controls_are_bounded_integers_with_explicit_defaults() {
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("6"),
            Some("1.5"),
            Some("-1"),
            Some("text"),
        ] {
            assert_eq!(perf_option(value, 1..=5, 1), 1);
        }
        assert_eq!(perf_option(Some("5"), 1..=5, 1), 5);
        assert_eq!(perf_option(Some("120"), 3..=120, 60), 120);
        assert_eq!(perf_option(Some("121"), 3..=120, 60), 60);
        assert_eq!(perf_option(Some("3"), 3..=120, 60), 3);
    }
}

#[tauri::command]
fn get_bootstrap(state: State<'_, Arc<AppState>>) -> Result<Bootstrap> {
    Ok(Bootstrap {
        epoch: state.epoch.clone(),
        projects: state.storage.lock().map_err(poisoned)?.projects.clone(),
        auto_benchmark: std::env::var("TRELLIS_PERF_AUTORUN").as_deref() == Ok("1"),
        auto_benchmark_repeats: perf_option(
            std::env::var("TRELLIS_PERF_REPEATS").ok().as_deref(),
            1..=5,
            1,
        ),
        auto_benchmark_seconds: perf_option(
            std::env::var("TRELLIS_PERF_SECONDS").ok().as_deref(),
            3..=120,
            60,
        ),
    })
}
#[tauri::command]
async fn choose_and_add_project(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<Project>> {
    let state = state.inner().clone();
    blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("选择包含 .trellis 的项目目录")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|e| format!("INVALID_PATH: {e}"))?;
        state.storage.lock().map_err(poisoned)?.add(&path).map(Some)
    })
    .await
}
#[tauri::command]
async fn remove_project(
    project_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Project>> {
    let state = state.inner().clone();
    blocking(move || {
        let _serial = state.activation_lock.lock().map_err(poisoned)?;
        // 等待已有日历扫描完成后清缓存，防止删除后旧扫描再次填回。
        let _scan = state.calendar_scan.lock().map_err(poisoned)?;
        let mut active = state.active.lock().map_err(poisoned)?;
        let mut cache = state.calendar_cache.lock().map_err(poisoned)?;
        let projects = state
            .storage
            .lock()
            .map_err(poisoned)?
            .remove(&project_id)?;
        if active
            .as_ref()
            .is_some_and(|item| item.project.id == project_id)
        {
            *active = None; // Drop 会停止该项目的文件监听线程。
        }
        cache.remove(&project_id);
        Ok(projects)
    })
    .await
}

#[tauri::command]
async fn reveal_project(project_id: String, state: State<'_, Arc<AppState>>) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || {
        let project = registered_project(&state, &project_id)?;
        if !std::path::Path::new(&project.path).is_dir() {
            return Err("项目目录不存在，无法在 Finder 中显示。".into());
        }
        #[cfg(target_os = "macos")]
        {
            // 路径作为独立参数传递，空格、中文或 shell 字符均不参与命令解释。
            let status = std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(&project.path)
                .status()
                .map_err(paths::io)?;
            if !status.success() {
                return Err("无法在 Finder 中显示项目。".into());
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        Err("在 Finder 中显示仅支持 macOS。".into())
    })
    .await
}

#[tauri::command]
async fn copy_project_path(project_id: String, state: State<'_, Arc<AppState>>) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || {
        let project = registered_project(&state, &project_id)?;
        #[cfg(target_os = "macos")]
        {
            use std::io::Write;
            use std::process::{Command, Stdio};
            // 显式 UTF-8，防止桌面启动环境没有 locale 时损坏中文路径。
            let mut child = Command::new("/usr/bin/pbcopy")
                .env("LC_ALL", "en_US.UTF-8")
                .stdin(Stdio::piped())
                .spawn()
                .map_err(paths::io)?;
            let write = child
                .stdin
                .take()
                .ok_or("无法连接剪贴板。")?
                .write_all(project.path.as_bytes());
            let status = child.wait().map_err(paths::io)?;
            write.map_err(paths::io)?;
            if !status.success() {
                return Err("无法复制项目路径。".into());
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = project;
            Err("复制项目路径仅支持 macOS。".into())
        }
    })
    .await
}

#[tauri::command]
async fn activate_project(
    project_id: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Snapshot> {
    let state = state.inner().clone();
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    blocking(move || {
        // 登记查询与激活发布在同一串行边界，避免移除后的旧激活重新安装监听。
        let _serial = state.activation_lock.lock().map_err(poisoned)?;
        let project = state
            .storage
            .lock()
            .map_err(poisoned)?
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .cloned()
            .ok_or("PROJECT_UNAVAILABLE: unregistered project")?;
        if state.generation.load(Ordering::Acquire) != generation {
            return Err("STALE_RESOURCE: activation superseded".into());
        }
        let active = service::start(project, state.epoch.clone(), app)?;
        let mut current = state.active.lock().map_err(poisoned)?;
        if state.generation.load(Ordering::Acquire) != generation {
            return Err("STALE_RESOURCE: activation superseded".into());
        }
        let snapshot = active.published.read().map_err(poisoned)?.snapshot.clone();
        *current = Some(active);
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn get_project_snapshot(
    project_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Snapshot> {
    let state = state.inner().clone();
    blocking(move || {
        let published = {
            let active = state.active.lock().map_err(poisoned)?;
            let active = active
                .as_ref()
                .filter(|p| p.project.id == project_id)
                .ok_or("STALE_RESOURCE: project is not active")?;
            active.published.clone()
        };
        let snapshot = published.read().map_err(poisoned)?.snapshot.clone();
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn get_project_changes(
    project_id: String,
    since_revision: u64,
    state: State<'_, Arc<AppState>>,
) -> Result<Changes> {
    let state = state.inner().clone();
    blocking(move || {
        let published = {
            let active = state.active.lock().map_err(poisoned)?;
            let active = active
                .as_ref()
                .filter(|p| p.project.id == project_id)
                .ok_or("STALE_RESOURCE: project is not active")?;
            active.published.clone()
        };
        let changes = published.read().map_err(poisoned)?.changes(since_revision);
        Ok(changes)
    })
    .await
}
fn task_path(state: &AppState, project_id: &str, key: &str) -> Result<PathBuf> {
    let project = {
        let active = state.active.lock().map_err(poisoned)?;
        let active = active
            .as_ref()
            .filter(|p| p.project.id == project_id)
            .ok_or("STALE_RESOURCE: project is not active")?;
        if !active
            .published
            .read()
            .map_err(poisoned)?
            .snapshot
            .tasks
            .iter()
            .any(|task| task.key == key)
        {
            return Err("TASK_NOT_FOUND: task is not in the registered index".into());
        }
        active.project.clone()
    };
    let root = paths::tasks_root(&project)?;
    paths::contained(&root, key)
}
#[tauri::command]
async fn get_document_tree(
    project_id: String,
    task_key: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<DocEntry>> {
    let state = state.inner().clone();
    blocking(move || {
        let path = task_path(&state, &project_id, &task_key)?;
        paths::document_tree(&path)
    })
    .await
}
#[tauri::command]
async fn read_document(
    project_id: String,
    task_key: String,
    document_key: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Document> {
    let state = state.inner().clone();
    blocking(move || {
        let path = task_path(&state, &project_id, &task_key)?;
        paths::read_document(&path, task_key, document_key)
    })
    .await
}
#[tauri::command]
async fn save_perf_report(
    report: serde_json::Value,
    state: State<'_, Arc<AppState>>,
) -> Result<String> {
    let state = state.inner().clone();
    blocking(move || {
        if !report.is_object() {
            return Err("INVALID_REPORT: expected object".into());
        }
        let directory = state
            .storage
            .lock()
            .map_err(poisoned)?
            .data_dir
            .join("performance");
        let mut report = report;
        report["epoch"] = state.epoch.clone().into();
        report["label"] = std::env::var("TRELLIS_PERF_LABEL")
            .unwrap_or_default()
            .into();
        if let Some(active) = state.active.lock().map_err(poisoned)?.as_ref() {
            report["backendBatches"] =
                serde_json::to_value(&*active.metrics.lock().map_err(poisoned)?)
                    .map_err(|e| e.to_string())?;
            report["backendScanMs"] = active
                .published
                .read()
                .map_err(poisoned)?
                .snapshot
                .scan_ms
                .into();
        }
        std::fs::create_dir_all(&directory).map_err(paths::io)?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let path = directory.join(format!("report-{timestamp}-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )
        .map_err(paths::io)?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
}

fn registered_project(state: &AppState, project_id: &str) -> Result<Project> {
    state
        .storage
        .lock()
        .map_err(poisoned)?
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or_else(|| "PROJECT_UNAVAILABLE: unregistered project".into())
}
fn calendar_project(state: &AppState, project: &Project, force: bool) -> Result<CalendarProject> {
    let published = {
        let active = state.active.lock().map_err(poisoned)?;
        active
            .as_ref()
            .filter(|active| active.project.id == project.id)
            .map(|active| active.published.clone())
    };
    if let Some(published) = published {
        let current = published.read().map_err(poisoned)?;
        return Ok(CalendarProject {
            project_id: project.id.clone(),
            tasks: current.snapshot.tasks.clone(),
            diagnostics: current.snapshot.diagnostics.clone(),
        });
    }
    // Serialize metadata scans independently of the active reader and project registry.
    let _scan = state.calendar_scan.lock().map_err(poisoned)?;
    registered_project(state, &project.id)?;
    if let Some(cached) = state
        .calendar_cache
        .lock()
        .map_err(poisoned)?
        .get(&project.id, force)
    {
        return Ok(cached);
    }
    let scanned = planner::scan_project(project)?;
    state
        .calendar_cache
        .lock()
        .map_err(poisoned)?
        .put(scanned.clone());
    Ok(scanned)
}
#[tauri::command]
async fn get_planner_settings(state: State<'_, Arc<AppState>>) -> Result<PlannerSettings> {
    let state = state.inner().clone();
    blocking(move || state.planner.lock().map_err(poisoned)?.settings()).await
}
#[tauri::command]
async fn set_project_color(
    project_id: String,
    color: String,
    state: State<'_, Arc<AppState>>,
) -> Result<PlannerSettings> {
    let state = state.inner().clone();
    blocking(move || {
        registered_project(&state, &project_id)?;
        state
            .planner
            .lock()
            .map_err(poisoned)?
            .color(project_id, color)
    })
    .await
}
#[tauri::command]
async fn get_calendar_project(
    project_id: String,
    force: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<CalendarProject> {
    let state = state.inner().clone();
    blocking(move || {
        let project = registered_project(&state, &project_id)?;
        calendar_project(&state, &project, force)
    })
    .await
}
#[tauri::command]
async fn update_task_schedule(
    input: ScheduleUpdate,
    state: State<'_, Arc<AppState>>,
) -> Result<PlannerSettings> {
    let state = state.inner().clone();
    blocking(move || {
        // A saved ID proves ownership even when its project is no longer registered.
        // Without an ID, require a registered project before clearing by task key.
        if input.start_date.is_none() && input.end_date.is_none() {
            if input.id.is_none() {
                registered_project(&state, &input.project_id)?;
            }
            return state.planner.lock().map_err(poisoned)?.clear(&input);
        }
        let project = registered_project(&state, &input.project_id)?;
        let calendar = calendar_project(&state, &project, true)?;
        state
            .planner
            .lock()
            .map_err(poisoned)?
            .update(input, &project, &calendar)
    })
    .await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(Arc::new(AppState {
                epoch: uuid::Uuid::new_v4().to_string(),
                planner: Mutex::new(planner::Planner::new(data_dir.clone())),
                calendar_cache: Mutex::new(planner::CalendarCache::default()),
                calendar_scan: Mutex::new(()),
                storage: Mutex::new(storage::Storage::new(data_dir)),
                active: Mutex::new(None),
                generation: AtomicU64::new(0),
                activation_lock: Mutex::new(()),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            choose_and_add_project,
            remove_project,
            reveal_project,
            copy_project_path,
            activate_project,
            get_project_snapshot,
            get_project_changes,
            get_document_tree,
            read_document,
            save_perf_report,
            get_planner_settings,
            set_project_color,
            update_task_schedule,
            get_calendar_project
        ])
        .run(tauri::generate_context!())
        .expect("unable to run Trellis Viewer");
}

/// Read-only scanner benchmark. Each iteration starts a fresh in-memory index;
/// this does not flush filesystem caches or claim native UI latency.
pub fn benchmark_index(project_path: &str, iterations: usize) -> Result<serde_json::Value> {
    let project = Project {
        id: "benchmark".into(),
        name: "benchmark".into(),
        path: project_path.into(),
    };
    if !std::path::Path::new(project_path).is_absolute() || !(1..=100).contains(&iterations) {
        return Err("benchmark requires an absolute path and 1..=100 iterations".into());
    }
    let root = paths::tasks_root(&project)?;
    let mut runs = Vec::new();
    for iteration in 0..iterations {
        let started = std::time::Instant::now();
        let mut index = index::Index::new(root.clone(), project.id.clone(), "benchmark".into());
        index.refresh(true, Default::default(), Default::default())?;
        let snapshot = &index.published.snapshot;
        runs.push(serde_json::json!({"iteration":iteration+1,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,"scanMs":snapshot.scan_ms,"tasks":snapshot.tasks.len(),"roots":snapshot.root_keys.len(),"diagnostics":snapshot.diagnostics.len(),"snapshotBytes":serde_json::to_vec(snapshot).map_err(|e|e.to_string())?.len()}));
    }
    Ok(
        serde_json::json!({"kind":"read-only-index-benchmark","filesystemCache":"not flushed","iterations":runs}),
    )
}
