import { describe, expect, it } from 'vitest';
import { moveTreeItem, orderedKeys, parseTreeOrder, treeOrderStorageKey } from './tree-ordering';
import { flattenTree } from './model';
import type { TaskSummary } from '../generated/contracts';
const task = (key: string, childKeys: string[] = []): TaskSummary => ({ key, title: key, childKeys, parentKey: null, status: 'planning', relativeDir: key, archived: false, revision: '1' });
const file = (path: string) => ({ key: path, name: path.split('/').pop()!, path });
describe('viewer tree ordering', () => {
  it('validates stored data, removes duplicates, isolates projects and appends new entries', () => {
    expect(parseTreeOrder('{')).toEqual({});
    expect(parseTreeOrder('[]')).toEqual({});
    expect(parseTreeOrder('{"a":["x","x"],"b":[1]}')).toEqual({ a: ['x'] });
    expect(treeOrderStorageKey('a')).not.toBe(treeOrderStorageKey('b'));
    expect(orderedKeys(['a', 'b', 'new'], ['b', 'gone', 'a'])).toEqual(['b', 'a', 'new']);
  });
  it('moves up/down, rejects non-siblings and retains absent entries across save/reload', () => {
    const initial = { scope: ['a', 'gone', 'b', 'c'] };
    const moved = moveTreeItem(initial, 'scope', ['a', 'b', 'c'], 'a', 'c');
    expect(orderedKeys(['a', 'b', 'c'], moved.scope)).toEqual(['b', 'c', 'a']);
    expect(moved.scope).toContain('gone');
    const restored = parseTreeOrder(JSON.stringify(moved));
    expect(moveTreeItem(restored, 'scope', ['a', 'b', 'c'], 'a', 'b').scope.slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(moveTreeItem(initial, 'scope', ['a', 'b'], 'a', 'other')).toBe(initial);
    expect(initial.scope).toEqual(['a', 'gone', 'b', 'c']);
  });
  it('moves expanded child task together with its documents without mutating source data', () => {
    const tasks = { root: task('root', ['a', 'b']), a: task('a'), b: task('b') };
    const docs = { a: [file('notes.md')] };
    const scope = JSON.stringify(['tasks', 'root']);
    const rows = flattenTree(tasks, 'root', docs, new Set(['task:a']), { [scope]: ['task:b', 'task:a'] });
    expect(rows.map(row => row.label)).toEqual(['root', '子任务（0/2）', 'b', 'a', 'notes.md']);
    expect(tasks.root.childKeys).toEqual(['a', 'b']);
    expect(rows.find(row => row.id === 'task:a')?.sortScope).toBe(scope);
    expect(rows[0].sortScope).toBeUndefined();
  });
  it('sorts sibling folders as full subtrees and keeps nested scopes separate', () => {
    const docs = { root: [file('first/a.md'), file('second/nested/b.md'), file('root.md')] };
    const scope = JSON.stringify(['folders', 'root', '']);
    const expanded = new Set(['folder:root:first', 'folder:root:second', 'folder:root:second/nested']);
    const order = { [scope]: ['folder:root:second', 'folder:root:first'] };
    const rows = flattenTree({ root: task('root') }, 'root', docs, expanded, order);
    expect(rows.map(row => row.label)).toEqual(['root', 'second', 'nested', 'b.md', 'first', 'a.md', 'root.md']);
    expect(rows.find(row => row.label === 'nested')?.sortScope).not.toBe(scope);
    expanded.delete('folder:root:second');
    expect(flattenTree({ root: task('root') }, 'root', docs, expanded, order).map(row => row.label)).toEqual(['root', 'second', 'first', 'a.md', 'root.md']);
    expect(docs.root[0].path).toBe('first/a.md');
  });
});
