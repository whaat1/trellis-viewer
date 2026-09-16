import { orderedKeys, type TreeOrder } from './tree-ordering';
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
    // Archive location alone neither excludes a task nor makes it complete.
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
  taskKey: string; documentKey?: string; sortScope?: string; expandable: boolean; open?: boolean;
  summary?: { completed: number; total: number; missing: number };
}
export function childGroupCollapseId(root: string) { return `collapsed-children:${root}`; }
export function flattenTree(tasks: Record<string, TaskSummary>, root: string, docs: Record<string, DocEntry[]>, expanded: Set<string>, order: TreeOrder = {}): TreeRow[] {
  const rows: TreeRow[] = [];
  const rootTask = tasks[root];
  if (!rootTask) return rows;
  function addDocuments(key: string, depth: number) {
    type Node = { path: string; label: string; doc?: DocEntry; children: Map<string, Node> };
    const tree: Node = { path: '', label: '', children: new Map() };
    for (const doc of docs[key] ?? []) {
      const parts = doc.path.split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join('/');
        if (!node.children.has(parts[i])) node.children.set(parts[i], { path, label: parts[i], children: new Map() });
        node = node.children.get(parts[i])!;
        if (i === parts.length - 1) node.doc = doc;
      }
    }
    function visit(node: Node, level: number) {
      const scope = JSON.stringify(['folders', key, node.path]);
      const children = [...node.children.values()];
      const folderIds = children.filter(child => !child.doc).map(child => `folder:${key}:${child.path}`);
      const sorted = orderedKeys(folderIds, order[scope]);
      const byId = new Map(children.map(child => [`folder:${key}:${child.path}`, child]));
      let folderIndex = 0;
      for (const original of children) {
        const child = original.doc ? original : byId.get(sorted[folderIndex++])!;
        if (child.doc) {
          rows.push({ id: `doc:${key}:${child.doc.key}`, label: child.doc.name, depth: level, kind: 'document', taskKey: key, documentKey: child.doc.key, expandable: false });
        } else {
          const id = `folder:${key}:${child.path}`;
          const open = expanded.has(id);
          rows.push({ id, label: child.label, depth: level, kind: 'folder', taskKey: key, sortScope: scope, expandable: true, open });
          if (open) visit(child, level + 1);
        }
      }
    }
    visit(tree, depth + 1);
  }
  const rootOpen = !expanded.has(`collapsed-task:${root}`);
  rows.push({ id: `task:${root}`, label: rootTask.title, depth: 0, kind: 'task', taskKey: root, expandable: true, open: rootOpen });
  if (rootOpen) addDocuments(root, 0);
  if (!rootTask.childKeys.length) return rows;
  // This is a child-list count, independent of project delivery progress.
  const children = [...new Set(rootTask.childKeys)].filter(key => key !== root);
  const total = children.length;
  const completed = children.filter(key => ['completed', 'done'].includes(tasks[key]?.status)).length;
  const missing = children.filter(key => !tasks[key]).length;
  const groupOpen = !expanded.has(childGroupCollapseId(root));
  rows.push({ id: `children:${root}`, label: `子任务（${completed}/${total}）`, depth: 0, kind: 'children', taskKey: root, expandable: true, open: groupOpen, summary: { completed, total, missing } });
  if (!groupOpen) return rows;
  const seen = new Set([root]);
  const childOrder = (parent: string) => orderedKeys(tasks[parent].childKeys.map(key => `task:${key}`), order[JSON.stringify(['tasks', parent])]).map(id => id.slice(5));
  const stack = childOrder(root).reverse().map(key => ({ key, parent: root, depth: 1 }));
  while (stack.length) {
    const { key, parent, depth } = stack.pop()!;
    if (seen.has(key) || !tasks[key]) continue;
    seen.add(key);
    const task = tasks[key];
    const id = `task:${key}`;
    const open = expanded.has(id);
    rows.push({ id, label: task.title, depth, kind: 'task', taskKey: key, sortScope: JSON.stringify(['tasks', parent]), expandable: true, open });
    if (!open) continue;
    addDocuments(key, depth);
    for (const child of childOrder(key).reverse()) stack.push({ key: child, parent: key, depth: depth + 1 });
  }
  return rows;
}
