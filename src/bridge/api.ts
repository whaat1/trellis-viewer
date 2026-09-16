import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Bootstrap, Project, Snapshot, Changes, DocEntry, Document as TaskDocument, Invalidated, PlannerSettings, ScheduleUpdate, CalendarProject } from '../generated/contracts';

export const demoMode = !isTauri() && new URLSearchParams(location.search).get('demo') === '1';
export const nativeMode = isTauri();
export const metrics = { ipcCalls: 0, patchCount: 0, upserts: 0, documentInvalidations: 0, markdownParses: 0, markdownCommits: 0, staleResponses: 0, snapshotInstallMs: 0, documentReadyCount: 0, documentReadyIdentity: '', lastDocumentParseMs: 0, lastDocumentReadMs: 0, lastDocumentSourceBytes: 0 };
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  metrics.ipcCalls++;
  if (nativeMode) return invoke<T>(command, args);
  if (demoMode) { const { demoInvoke } = await import('./demo'); return demoInvoke<T>(command, args); }
  throw new Error('请从桌面应用打开。浏览器演示须显式使用 ?demo=1。');
}
function invalidation(value: unknown): value is Invalidated {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.projectId === 'string' && typeof v.epoch === 'string' && typeof v.revision === 'number' && Number.isSafeInteger(v.revision) && v.revision >= 0;
}
export const api = {
  focusWindow: async () => { if (nativeMode) await getCurrentWindow().setFocus(); else window.focus(); },
  windowFocused: async () => nativeMode ? getCurrentWindow().isFocused() : document.hasFocus(),
  subscribeWindowFocus: async (handler: (focused: boolean) => void) => {
    if (nativeMode) return getCurrentWindow().onFocusChanged(event => handler(event.payload));
    const focus = () => handler(true); const blur = () => handler(false);
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  },
  bootstrap: () => call<Bootstrap>('get_bootstrap'),
  addProject: () => call<Project | null>('choose_and_add_project'),
  removeProject: (projectId: string) => call<Project[]>('remove_project', { projectId }),
  revealProject: (projectId: string) => call<void>('reveal_project', { projectId }),
  copyProjectPath: (projectId: string) => call<void>('copy_project_path', { projectId }),
  reorderProjects: (projectIds: string[]) => call<Project[]>('reorder_projects', { projectIds }),
  activate: (projectId: string) => call<Snapshot>('activate_project', { projectId }),
  snapshot: (projectId: string) => call<Snapshot>('get_project_snapshot', { projectId }),
  changes: (projectId: string, sinceRevision: number) => call<Changes>('get_project_changes', { projectId, sinceRevision }),
  tree: (projectId: string, taskKey: string) => call<DocEntry[]>('get_document_tree', { projectId, taskKey }),
  document: (projectId: string, taskKey: string, documentKey: string) => call<TaskDocument>('read_document', { projectId, taskKey, documentKey }),
  plannerSettings: () => call<PlannerSettings>('get_planner_settings'),
  calendarProject: (projectId: string, force = false) => call<CalendarProject>('get_calendar_project', { projectId, force }),
  setProjectColor: (projectId: string, color: string) => call<PlannerSettings>('set_project_color', { projectId, color }),
  updateTaskSchedule: (input: ScheduleUpdate) => call<PlannerSettings>('update_task_schedule', { input }),
  saveReport: (report: unknown) => call<string>('save_perf_report', { report }),
  subscribe: async (handler: (event: Invalidated) => void) => {
    if (!nativeMode) return () => {};
    return listen<unknown>('project-invalidated', ({ payload }) => { if (invalidation(payload)) handler(payload); });
  },
};
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return '读取失败，请重新选择项目后重试。';
}
