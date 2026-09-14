import type { Changes, Snapshot, TaskSummary, DocEntry } from '../generated/contracts';
export interface TaskIndex { projectId: string; epoch: string; revision: number; tasks: Record<string, TaskSummary>; rootKeys: string[] }
export function fromSnapshot(snapshot: Snapshot, previous?: TaskIndex | null): TaskIndex {
  const tasks: Record<string, TaskSummary> = Object.create(null);
  for (const task of snapshot.tasks) {
    const old = previous?.projectId === snapshot.projectId ? previous.tasks[task.key] : undefined;
    tasks[task.key] = old?.revision === task.revision && JSON.stringify(old) === JSON.stringify(task) ? old : task;
  }
  return { projectId: snapshot.projectId, epoch: snapshot.epoch, revision: snapshot.revision, tasks, rootKeys: snapshot.rootKeys };
}
export function applyChanges(current: TaskIndex, changes: Changes): TaskIndex | null {
  if (changes.resetRequired || changes.projectId !== current.projectId || changes.epoch !== current.epoch || changes.baseRevision !== current.revision || changes.revision < current.revision) return null;
  const tasks = changes.upserts.length || changes.removed.length ? { ...current.tasks } : current.tasks;
  for (const key of changes.removed) delete tasks[key];
  for (const task of changes.upserts) tasks[task.key] = task;
  return { ...current, tasks, revision: changes.revision, rootKeys: changes.rootKeys ?? current.rootKeys };
}
export class LatestRequest {
  private generation = 0;
  next() { return ++this.generation; }
  token() { return this.generation; }
  current(id: number) { return this.generation === id; }
  cancel() { this.generation++; }
}
export const statuses = [ ['all', '全部'], ['planning', '规划中'], ['in_progress', '进行中'], ['review', '待审查'], ['completed', '已完成'], ['archived', '已归档'] ] as const;
export type StatusFilter = typeof statuses[number][0];
export function taskStatus(task: TaskSummary) { return task.archived ? 'archived' : task.status === 'done' ? 'completed' : task.status; }
export function statusLabel(task: TaskSummary) { return statuses.find(([key]) => key === taskStatus(task))?.[1] ?? (task.status === 'cancelled' ? '已取消' : '未知状态'); }
export const projectStatusGroups = [...statuses.filter(([key]) => key === 'archived'), ...statuses.filter(([key]) => key !== 'all' && key !== 'archived'), ['unknown', '未知状态']] as const;
export function projectProgress(tasks: Record<string, TaskSummary> = {}) {
  let total = 0;
  let completed = 0;
  const statusCounts: Record<string, number> = {};
  for (const task of Object.values(tasks)) {
    // Parents are groups; explicitly cancelled work is outside the delivery scope.
    // Archive location alone never excludes a terminal task or makes it complete.
    if (task.childKeys.length || task.status === 'cancelled') continue;
    total++;
    const status = taskStatus(task);
    const bucket = projectStatusGroups.some(([key]) => key === status) ? status : 'unknown';
    statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
    if (task.status === 'completed' || task.status === 'done') completed++;
  }
  return { total, completed, percent: total ? Math.floor(completed / total * 100) : 0, statusCounts };
}
export interface TreeRow {
  id: string; label: string; depth: number; kind: 'task' | 'folder' | 'document' | 'children';
  taskKey: string; documentKey?: string; expandable: boolean; open?: boolean;
  summary?: { completed: number; total: number; missing: number };
}
export function childGroupCollapseId(root: string) { return `collapsed-children:${root}`; }
export function flattenTree(tasks: Record<string, TaskSummary>, root: string, docs: Record<string, DocEntry[]>, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const rootTask = tasks[root];
  if (!rootTask) return rows;
  function addDocuments(key: string, depth: number, alwaysOpen: boolean) {
    const folders = new Set<string>();
    for (const doc of docs[key] ?? []) {
      const parts = doc.path.split('/');
      let visible = true;
      for (let i = 0; i < parts.length - 1; i++) {
        const folderPath = parts.slice(0, i + 1).join('/');
        const folderId = `folder:${key}:${folderPath}`;
        const open = alwaysOpen || expanded.has(folderId);
        if (!folders.has(folderId)) { folders.add(folderId); rows.push({ id: folderId, label: parts[i], depth: depth + i + 1, kind: 'folder', taskKey: key, expandable: !alwaysOpen, open }); }
        if (!open) { visible = false; break; }
      }
      if (visible) rows.push({ id: `doc:${key}:${doc.key}`, label: doc.name, depth: depth + parts.length, kind: 'document', taskKey: key, documentKey: doc.key, expandable: false });
    }
  }
  rows.push({ id: `task:${root}`, label: rootTask.title, depth: 0, kind: 'task', taskKey: root, expandable: false, open: true });
  addDocuments(root, 0, true);
  if (!rootTask.childKeys.length) return rows;
  // Count all known terminal descendants once, independent of UI expansion.
  // Root/group rows are presentation only and never enter projectProgress.
  const descendants: Record<string, TaskSummary> = Object.create(null);
  const counted = new Set([root]);
  const counting = [...rootTask.childKeys];
  let missing = 0;
  while (counting.length) {
    const key = counting.pop()!;
    if (counted.has(key)) continue;
    counted.add(key);
    const task = tasks[key];
    if (!task) { missing++; continue; }
    descendants[key] = task;
    for (const child of task.childKeys) counting.push(child);
  }
  const { completed, total } = projectProgress(descendants);
  const groupOpen = !expanded.has(childGroupCollapseId(root));
  rows.push({ id: `children:${root}`, label: `子任务（${completed}/${total}）`, depth: 0, kind: 'children', taskKey: root, expandable: true, open: groupOpen, summary: { completed, total, missing } });
  if (!groupOpen) return rows;
  const seen = new Set([root]);
  const stack = [...rootTask.childKeys].reverse().map(key => ({ key, depth: 1 }));
  while (stack.length) {
    const { key, depth } = stack.pop()!;
    if (seen.has(key) || !tasks[key]) continue;
    seen.add(key);
    const task = tasks[key];
    const id = `task:${key}`;
    const open = expanded.has(id);
    rows.push({ id, label: task.title, depth, kind: 'task', taskKey: key, expandable: true, open });
    if (!open) continue;
    addDocuments(key, depth, false);
    for (let index = task.childKeys.length - 1; index >= 0; index--) stack.push({ key: task.childKeys[index], depth: depth + 1 });
  }
  return rows;
}
