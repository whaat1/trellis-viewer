import { describe, it, expect } from 'vitest';
import { applyChanges, childGroupCollapseId, fromSnapshot, flattenTree, LatestRequest, projectProgress } from './model';
import type { TaskSummary, Snapshot, Changes } from '../generated/contracts';
const task = (key: string, children: string[] = []): TaskSummary => ({ key, title: key, status: 'planning', relativeDir: key, parentKey: null, childKeys: children, archived: false, revision: '1' });
const snapshot: Snapshot = { projectId: 'p', epoch: 'e', revision: 4, tasks: [task('parent', ['child']), task('child'), task('other')], rootKeys: ['parent', 'other'], scanMs: 0, diagnostics: [] };
const changes = (overrides: Partial<Changes> = {}): Changes => ({ projectId: 'p', epoch: 'e', baseRevision: 4, revision: 5, resetRequired: false, upserts: [], removed: [], rootKeys: null, documentTaskKeys: [], diagnostics: [], ...overrides });
describe('atomic task index updates', () => {
  it('rejects project/epoch/revision gaps instead of mixing histories', () => {
    const index = fromSnapshot(snapshot);
    for (const delta of [{ projectId: 'q' }, { epoch: 'new' }, { baseRevision: 3 }, { revision: 2 }, { resetRequired: true }]) expect(applyChanges(index, changes(delta))).toBeNull();
  });
  it('keeps unrelated objects stable while applying a removal and status update atomically', () => {
    const index = fromSnapshot(snapshot);
    const changed = { ...index.tasks.child, status: 'completed', revision: '2' };
    const next = applyChanges(index, changes({ upserts: [changed], removed: ['other'], rootKeys: ['parent'] }))!;
    expect(next.tasks.parent).toBe(index.tasks.parent);
    expect(next.tasks.child.status).toBe('completed'); expect(next.tasks.other).toBeUndefined();
    expect(index.tasks.other).toBeDefined(); expect(index.tasks.child.status).toBe('planning');
    expect(next.rootKeys).toEqual(['parent']);
  });
  it('document-only invalidation does not replace task data', () => {
    const index = fromSnapshot(snapshot); expect(applyChanges(index, changes({ documentTaskKeys: ['child'] }))!.tasks).toBe(index.tasks);
  });
});
describe('flattened task/document tree', () => {
  const file = (path: string) => ({ key: path, name: path.split('/').pop()!, path });
  it('shows root and folders collapsed by default while child tasks start folded', () => {
    const index = fromSnapshot(snapshot);
    const docs = { parent: [file('prd.md'), file('research/nested/notes.md')], child: [file('child.md')] };
    const rows = flattenTree(index.tasks, 'parent', docs, new Set(['task:parent', 'folder:parent:research', 'folder:parent:research/nested']));
    expect(rows.map(row => row.label)).toEqual(['parent', 'prd.md', 'research', 'nested', 'notes.md', '子任务（0/1）', 'child']);
    expect(rows[0]).toMatchObject({ expandable: true, open: true });
    expect(rows.filter(row => row.kind === 'folder').every(row => row.expandable && row.open === false)).toBe(false);
    expect(flattenTree(index.tasks, 'parent', docs, new Set(['collapsed-task:parent'])).map(row => row.label)).toEqual(['parent', '子任务（0/1）', 'child']);
    expect(rows.find(row => row.documentKey === 'research/nested/notes.md')?.depth).toBe(3);
    expect(rows.at(-1)).toMatchObject({ kind: 'task', depth: 1, open: false });
    expect(rows.some(row => row.documentKey === 'child.md')).toBe(false);
  });
  it('folds only the child group and restores explicit child and folder expansion without touching root files', () => {
    const index = fromSnapshot(snapshot);
    const docs = { parent: [file('root/nested.md')], child: [file('research/nested/child.md')] };
    const expanded = new Set(['task:parent', 'task:child', 'folder:parent:root', 'folder:child:research']);
    let rows = flattenTree(index.tasks, 'parent', docs, expanded);
    expect(rows.map(row => row.label)).toEqual(['parent', 'root', 'nested.md', '子任务（0/1）', 'child', 'research', 'nested']);
    expanded.add('folder:child:research/nested');
    rows = flattenTree(index.tasks, 'parent', docs, expanded);
    expect(rows.find(row => row.documentKey === 'research/nested/child.md')?.depth).toBe(4);
    expanded.add(childGroupCollapseId('parent'));
    expect(flattenTree(index.tasks, 'parent', docs, expanded).map(row => row.label)).toEqual(['parent', 'root', 'nested.md', '子任务（0/1）']);
    expanded.delete(childGroupCollapseId('parent'));
    expect(flattenTree(index.tasks, 'parent', docs, expanded).some(row => row.label === 'child.md')).toBe(true);
  });
  it('counts terminal descendants across levels exactly once, excluding archived and cancelled work', () => {
    const tasks = { parent: task('parent', ['group', 'archived', 'cancelled', 'done']), group: task('group', ['done', 'nested']), done: { ...task('done'), status: 'done' }, nested: { ...task('nested'), status: 'completed', archived: true }, archived: { ...task('archived'), archived: true }, cancelled: { ...task('cancelled'), status: 'cancelled' } };
    const folded = flattenTree(tasks, 'parent', {}, new Set([childGroupCollapseId('parent')]));
    expect(folded.find(row => row.kind === 'children')?.summary).toEqual({ completed: 1, total: 1, missing: 0 });
    const open = flattenTree(tasks, 'parent', {}, new Set(['task:parent', 'task:group']));
    expect(open.find(row => row.kind === 'children')?.label).toBe('子任务（1/1）');
    expect(open.filter(row => row.kind === 'task').map(row => [row.taskKey, row.depth])).toEqual([['parent', 0], ['group', 1], ['done', 2], ['nested', 2], ['archived', 1], ['cancelled', 1]]);
  });
  it('terminates cycles, reports missing references, and does not invent a child group for an independent task', () => {
    const tasks = { a: task('a', ['b', 'missing']), b: task('b', ['a', 'b']) };
    const rows = flattenTree(tasks, 'a', {}, new Set(['task:a', 'task:b']));
    expect(rows.filter(row => row.kind === 'task').map(row => row.taskKey)).toEqual(['a', 'b']);
    expect(rows.find(row => row.kind === 'children')?.summary).toEqual({ completed: 0, total: 0, missing: 1 });
    expect(flattenTree({ solo: task('solo') }, 'solo', { solo: [file('prd.md')] }, new Set(['task:solo'])).map(row => row.kind)).toEqual(['task', 'document']);
  });
});
it('request tokens reject stale results after cancel or a newer selection', () => {
  const requests = new LatestRequest(); const first = requests.next(); const second = requests.next();
  expect(requests.current(first)).toBe(false); expect(requests.current(second)).toBe(true);
  requests.cancel(); expect(requests.current(second)).toBe(false);
});
describe('project completion across active terminal tasks', () => {
  it('reaches 100% when nested leaves and independent tasks complete regardless of group statuses', () => {
    const result = projectProgress({
      parent: task('parent', ['group', 'child']), group: task('group', ['nested']),
      child: { ...task('child'), status: 'completed' },
      nested: { ...task('nested'), status: 'completed', archived: true },
      independent: { ...task('independent'), status: 'done' },
    });
    expect(result).toEqual({ total: 2, completed: 2, percent: 100, statusCounts: { completed: 2 } });
  });
  it('excludes archived tasks from the denominator and status counts', () => {
    const result = projectProgress({
      parent: { ...task('parent', ['done', 'unfinished']), status: 'completed', archived: true },
      done: { ...task('done'), archived: true, status: 'completed' },
      unfinished: { ...task('unfinished'), archived: true },
      review: { ...task('review'), status: 'review' },
    });
    expect(result).toEqual({ total: 1, completed: 0, percent: 0, statusCounts: { review: 1 } });
  });
  it('does not claim completion for no tasks or round unfinished work up to 100%', () => {
    expect(projectProgress().percent).toBe(0);
    const tasks = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), { ...task(String(i)), status: i ? 'completed' : 'planning' }]));
    expect(projectProgress(tasks).percent).toBe(99);
  });
  it('excludes explicitly cancelled work without altering archive records or excluding unknown statuses', () => {
    const cancelled = { ...task('cancelled'), archived: true, status: 'cancelled' };
    const finished = Object.fromEntries(Array.from({ length: 67 }, (_, i) => [String(i), { ...task(String(i)), archived: true, status: 'completed' }]));
    const tasks = { ...finished, cancelled, liveCancelled: { ...task('liveCancelled'), status: 'cancelled' } };
    expect(projectProgress(tasks)).toEqual({ total: 0, completed: 0, percent: 0, statusCounts: {} });
    expect(tasks.cancelled).toBe(cancelled);
    expect(tasks.cancelled.status).toBe('cancelled');
    expect(projectProgress({ cancelled })).toEqual({ total: 0, completed: 0, percent: 0, statusCounts: {} });
    expect(projectProgress({ ...tasks, unknown: { ...task('unknown'), archived: true, status: 'unknown' } }).total).toBe(0);
  });
});
