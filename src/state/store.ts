import { create } from 'zustand';
import { forgetCalendarProject } from './planner';
import { api, errorText, metrics } from '../bridge/api';
import type { Project, Invalidated, DocEntry, Snapshot } from '../generated/contracts';
import { fromSnapshot, applyChanges, childGroupCollapseId, LatestRequest, type StatusFilter, type TaskIndex } from './model';
interface State {
  projects: Project[]; projectId: string; index: TaskIndex | null; filter: StatusFilter; rootKey: string;
  selectedDoc: { taskKey: string; key: string } | null; docs: Record<string, DocEntry[]>;
  treeVersions: Record<string, { version: number; reset: number }>; pendingRootKey: string | null;
  expanded: Set<string>; documentVersions: Record<string, number>; documentReset: number;
  loading: boolean; error: string; diagnostics: string[]; scanMs: number; autoBenchmark: boolean; autoBenchmarkRepeats: number; autoBenchmarkSeconds: number;
}
export const useStore = create<State>(() => ({ projects: [], projectId: '', index: null, filter: 'all', rootKey: '', selectedDoc: null, docs: {}, treeVersions: {}, pendingRootKey: null, expanded: new Set(), documentVersions: {}, documentReset: 0, loading: true, error: '', diagnostics: [], scanMs: 0, autoBenchmark: false, autoBenchmarkRepeats: 1, autoBenchmarkSeconds: 60 }));
const activation = new LatestRequest();
const removedProjects = new Set<string>();
let activating: { projectId: string; ticket: number; request: Promise<Snapshot> } | undefined;
const pendingEvents = new Map<string, Invalidated>();
let syncing = false;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let alive = false;
const treePending = new Map<string, Promise<DocEntry[]>>();
const memory = new Map<string, Pick<State, 'filter' | 'rootKey' | 'selectedDoc' | 'expanded'>>();
function chooseValid(state: State, index: TaskIndex) {
  const rootKey = index.tasks[state.rootKey] ? state.rootKey : index.rootKeys[0] ?? '';
  const selectedDoc = state.selectedDoc && index.tasks[state.selectedDoc.taskKey] ? state.selectedDoc : null;
  const pendingRootKey = rootKey !== state.rootKey ? rootKey || null : state.pendingRootKey && index.tasks[state.pendingRootKey] ? state.pendingRootKey : null;
  const expanded = rootKey && !state.expanded.has(`task:${rootKey}`) ? new Set(state.expanded).add(`task:${rootKey}`) : state.expanded;
  return { rootKey, selectedDoc, pendingRootKey, expanded };
}
function pruneRemovedTrees(state: State, index: TaskIndex): Partial<State> {
  const removed = Object.keys(state.docs).filter(key => !index.tasks[key]);
  if (!removed.length) return {};
  const docs = { ...state.docs }; const treeVersions = { ...state.treeVersions };
  for (const key of removed) { delete docs[key]; delete treeVersions[key]; }
  return { docs, treeVersions };
}
export async function activateProject(projectId: string) {
  if (removedProjects.has(projectId)) return;
  const old = useStore.getState();
  if (old.projectId === projectId && old.index && !old.loading && !old.error) return;
  if (old.projectId === projectId && old.loading && activating?.projectId === projectId && activation.current(activating.ticket)) {
    await activating.request.catch(() => {});
    return;
  }
  if (old.projectId) memory.set(old.projectId, { filter: old.filter, rootKey: old.rootKey, selectedDoc: old.selectedDoc, expanded: old.expanded });
  const ticket = activation.next();
  const remembered = memory.get(projectId);
  useStore.setState({ projectId, index: null, docs: {}, treeVersions: {}, pendingRootKey: null, rootKey: '', expanded: new Set(), loading: true, error: '', filter: 'all', documentVersions: {}, ...remembered, selectedDoc: null });
  try {
    const request = api.activate(projectId);
    activating = { projectId, ticket, request };
    const snapshot = await request;
    if (!activation.current(ticket)) { metrics.staleResponses++; return; }
    const start = performance.now();
    const index = fromSnapshot(snapshot);
    const selected = chooseValid({ ...useStore.getState(), selectedDoc: remembered?.selectedDoc ?? null }, index);
    const expanded = new Set(useStore.getState().expanded).add(`task:${selected.rootKey}`);
    useStore.setState({ index, ...selected, pendingRootKey: selected.selectedDoc ? null : selected.rootKey || null, expanded, loading: false, scanMs: snapshot.scanMs, diagnostics: snapshot.diagnostics });
    metrics.snapshotInstallMs = performance.now() - start;
    // Restore expanded children sequentially so project restoration cannot
    // flood the backend with one read per previously opened task.
    void (async () => {
      if (selected.rootKey) await ensureTree(selected.rootKey, true);
      for (const id of expanded) {
        if (!activation.current(ticket)) break;
        if (id.startsWith('task:') && id !== `task:${selected.rootKey}` && index.tasks[id.slice(5)]) await ensureTree(id.slice(5));
      }
    })();
    void syncPending();
  } catch (error) { if (activation.current(ticket)) useStore.setState({ loading: false, error: errorText(error) }); }
  finally { if (activating?.ticket === ticket) activating = undefined; }
}
export async function initialize() {
  alive = true;
  const unsubscribe = await api.subscribe(event => {
    if (removedProjects.has(event.projectId)) return;
    const previous = pendingEvents.get(event.projectId);
    if (!previous || previous.epoch !== event.epoch || previous.revision < event.revision) pendingEvents.set(event.projectId, event);
    retryCount = 0; void syncPending();
  });
  try {
    const bootstrap = await api.bootstrap();
    if (!alive) { unsubscribe(); return () => {}; }
    useStore.setState({ projects: bootstrap.projects, autoBenchmark: bootstrap.autoBenchmark, autoBenchmarkRepeats: bootstrap.autoBenchmarkRepeats, autoBenchmarkSeconds: bootstrap.autoBenchmarkSeconds, loading: false });
    if (bootstrap.projects[0]) await activateProject(bootstrap.projects[0].id);
  } catch (error) { useStore.setState({ loading: false, error: errorText(error) }); }
  return () => { alive = false; activation.cancel(); if (retryTimer) clearTimeout(retryTimer); unsubscribe(); };
}
async function syncPending() {
  if (syncing) return;
  syncing = true;
  let context: { projectId: string; ticket: number } | undefined;
  try {
    for (;;) {
      const state = useStore.getState();
      if (!state.index || state.loading) break;
      const event = pendingEvents.get(state.projectId);
      if (!event) break;
      if (event.epoch === state.index.epoch && event.revision <= state.index.revision) { pendingEvents.delete(state.projectId); continue; }
      const ticket = activation.token();
      const projectId = state.projectId;
      context = { projectId, ticket };
      const changes = await api.changes(projectId, state.index.revision);
      const now = useStore.getState();
      if (!activation.current(ticket) || now.projectId !== projectId || !now.index || now.loading) continue;
      let index = applyChanges(now.index, changes);
      if (!index) {
        const snapshot = await api.snapshot(projectId);
        if (!activation.current(ticket) || useStore.getState().projectId !== projectId) continue;
        index = fromSnapshot(snapshot, useStore.getState().index);
        useStore.setState({ index, ...pruneRemovedTrees(useStore.getState(), index), ...chooseValid(useStore.getState(), index), documentReset: useStore.getState().documentReset + 1, diagnostics: snapshot.diagnostics });
        for (const id of useStore.getState().expanded) if (id.startsWith('task:')) void ensureTree(id.slice(5));
      } else {
        metrics.patchCount++;
        metrics.upserts += changes.upserts.length;
        metrics.documentInvalidations += changes.documentTaskKeys.length;
        const documentVersions = changes.documentTaskKeys.length ? { ...now.documentVersions } : now.documentVersions;
        for (const key of changes.documentTaskKeys) documentVersions[key] = (documentVersions[key] ?? 0) + 1;
        useStore.setState({ index, ...pruneRemovedTrees(now, index), ...chooseValid(now, index), documentVersions, diagnostics: changes.diagnostics });
        for (const key of changes.documentTaskKeys) if (now.expanded.has(`task:${key}`)) void ensureTree(key);
      }
      const pendingRoot = useStore.getState().pendingRootKey;
      if (pendingRoot) void ensureTree(pendingRoot, true);
      retryCount = 0;
      const pending = pendingEvents.get(projectId);
      if (pending === event) pendingEvents.delete(projectId);
    }
  } catch (error) {
    if (!context || (activation.current(context.ticket) && useStore.getState().projectId === context.projectId)) {
      useStore.setState({ error: errorText(error) });
      if (retryCount < 3) { const delay = 250 * 2 ** retryCount++; retryTimer = setTimeout(() => { void syncPending(); }, delay); }
    }
  } finally {
    syncing = false;
    if (context && (!activation.current(context.ticket) || useStore.getState().projectId !== context.projectId)) void syncPending();
  }
}
export async function addProject() {
  try {
    const project = await api.addProject();
    if (!project) return;
    removedProjects.delete(project.id);
    useStore.setState(state => ({ projects: state.projects.some(p => p.id === project.id) ? state.projects : [...state.projects, project] }));
    await activateProject(project.id);
  } catch (error) { useStore.setState({ error: errorText(error) }); }
}
export async function reorderProjects(projectIds: string[]) {
  try { const projects = await api.reorderProjects(projectIds); useStore.setState({ projects }); }
  catch (error) { useStore.setState({ error: errorText(error) }); }
}
export function setFilter(filter: StatusFilter) { useStore.setState({ filter }); }
export function selectRoot(rootKey: string) {
  const state = useStore.getState();
  if (state.rootKey === rootKey) {
    const cached = state.treeVersions[rootKey];
    const fresh = state.docs[rootKey] && cached?.version === (state.documentVersions[rootKey] ?? 0) && cached.reset === state.documentReset;
    if (!state.error || fresh) return;
  }
  useStore.setState({ rootKey, pendingRootKey: rootKey, error: '', expanded: new Set(state.expanded).add(`task:${rootKey}`) });
  void ensureTree(rootKey, true);
}
export async function ensureTree(taskKey: string, autoSelect = false) {
  const state = useStore.getState();
  if (state.loading || !state.index?.tasks[taskKey]) return;
  const projectId = state.projectId;
  const ticket = activation.token();
  const version = state.documentVersions[taskKey] ?? 0;
  const cacheKey = `${projectId}:${ticket}:${taskKey}:${version}:${state.documentReset}`;
  const isCurrent = () => {
    const current = useStore.getState();
    return activation.current(ticket) && current.projectId === projectId && !!current.index?.tasks[taskKey] &&
      (current.documentVersions[taskKey] ?? 0) === version && current.documentReset === state.documentReset;
  };
  try {
    let docs = state.docs[taskKey];
    const cached = state.treeVersions[taskKey];
    const fresh = docs && cached?.version === version && cached.reset === state.documentReset;
    if (!fresh) {
      let request = treePending.get(cacheKey);
      if (!request) { request = api.tree(projectId, taskKey); treePending.set(cacheKey, request); request.finally(() => treePending.delete(cacheKey)).catch(() => {}); }
      docs = await request;
      if (!isCurrent()) { metrics.staleResponses++; return; }
    }
    const current = useStore.getState();
    if (!isCurrent() || !current.index?.tasks[taskKey]) return;
    let selectedDoc = current.selectedDoc;
    let pendingRootKey = current.pendingRootKey;
    if (current.rootKey === taskKey && (pendingRootKey === taskKey || (autoSelect && !selectedDoc))) {
      if (selectedDoc?.taskKey !== taskKey || !docs.some(doc => doc.key === selectedDoc?.key)) selectedDoc = docs[0] ? { taskKey, key: docs[0].key } : null;
      pendingRootKey = null;
    } else if (selectedDoc?.taskKey === taskKey && !docs.some(doc => doc.key === selectedDoc?.key)) {
      selectedDoc = docs[0] ? { taskKey, key: docs[0].key } : null;
    }
    if (selectedDoc?.taskKey === current.selectedDoc?.taskKey && selectedDoc?.key === current.selectedDoc?.key) selectedDoc = current.selectedDoc;
    // Publish a fresh tree and its selection together. The previous tree stays
    // visible throughout I/O, including failed and superseded refreshes.
    useStore.setState({
      ...(!fresh ? { docs: { ...current.docs, [taskKey]: docs }, treeVersions: { ...current.treeVersions, [taskKey]: { version, reset: state.documentReset } } } : {}),
      selectedDoc, pendingRootKey,
    });
  } catch (error) {
    if (isCurrent()) {
      const current = useStore.getState();
      useStore.setState({ error: errorText(error), ...(current.pendingRootKey === taskKey ? { pendingRootKey: null } : {}) });
    }
  }
}
export function toggleExpanded(id: string, taskKey?: string) {
  const state = useStore.getState();
  const effectiveId = id === `task:${state.rootKey}` ? `collapsed-task:${state.rootKey}` : id;
  const expanded = new Set(state.expanded);
  if (effectiveId === `collapsed-task:${state.rootKey}`) { if (expanded.has(effectiveId)) expanded.delete(effectiveId); else expanded.add(effectiveId); }
  else if (expanded.has(effectiveId)) expanded.delete(effectiveId); else { expanded.add(effectiveId); if (taskKey) void ensureTree(taskKey); }
  useStore.setState({ expanded });
}
export function selectDocument(taskKey: string, key: string) {
  const state = useStore.getState();
  const groupId = childGroupCollapseId(state.rootKey);
  const nextExpanded = new Set(state.expanded);
  // Reveal the selected task and every ancestor in the task hierarchy.
  if (taskKey !== state.rootKey) nextExpanded.delete(groupId);
  const tasks = state.index?.tasks ?? {};
  const parentOf = new Map<string, string>();
  for (const task of Object.values(tasks)) for (const child of task.childKeys) parentOf.set(child, task.key);
  if (taskKey === state.rootKey) nextExpanded.delete(`collapsed-task:${state.rootKey}`);
  const visited = new Set<string>();
  let cursor = taskKey;
  while (cursor && cursor !== state.rootKey && !visited.has(cursor)) { visited.add(cursor); nextExpanded.add(`task:${cursor}`); cursor = parentOf.get(cursor) ?? ''; }
  const entry = state.docs[taskKey]?.find(doc => doc.key === key);
  if (entry) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) nextExpanded.add(`folder:${taskKey}:${parts.slice(0, i).join('/')}`);
  }
  const changed = nextExpanded.size !== state.expanded.size || [...nextExpanded].some(id => !state.expanded.has(id));
  const expansion = changed ? { expanded: nextExpanded } : {};
  if (state.selectedDoc?.taskKey === taskKey && state.selectedDoc.key === key) {
    if (state.pendingRootKey || changed) useStore.setState({ pendingRootKey: null, ...expansion });
    return;
  }
  useStore.setState({ selectedDoc: { taskKey, key }, pendingRootKey: null, ...expansion });
}

export async function removeProject(projectId: string) {
  // 等持久化成功才修改界面；等待期间用户仍可能切换到其他项目。
  const projects = await api.removeProject(projectId);
  removedProjects.add(projectId);
  pendingEvents.delete(projectId);
  memory.delete(projectId);
  forgetCalendarProject(projectId);
  const current = useStore.getState();
  if (current.projectId !== projectId) { useStore.setState({ projects }); return; }
  activation.cancel();
  activating = undefined;
  if (retryTimer) clearTimeout(retryTimer);
  // 先撤销阅读目标和缓存，避免旧读取成功或失败覆盖移除后的空状态。
  useStore.setState({ projects, projectId: '', index: null, docs: {}, treeVersions: {},
    selectedDoc: null, rootKey: '', pendingRootKey: null, expanded: new Set(),
    documentVersions: {}, documentReset: current.documentReset + 1,
    loading: false, error: '', diagnostics: [], scanMs: 0, filter: 'all' });
  if (projects[0]) await activateProject(projects[0].id);
}
