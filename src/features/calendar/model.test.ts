import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../../generated/contracts';
import { calendarTaskEditable, parentTaskDetails, daysBetween, localDate, pendingTasks, parseLocalDate, shiftMonth, validRange } from './model';

describe('local calendar dates', () => {
  it('validates actual civil dates and counts days across DST', () => {
    expect(parseLocalDate('2025-02-29')).toBeNull();
    expect(parseLocalDate('2024-02-29')).not.toBeNull();
    expect(parseLocalDate('2026-13-01')).toBeNull();
    expect(parseLocalDate('2026-1-01')).toBeNull();
    expect(localDate(parseLocalDate('2026-03-08')!)).toBe('2026-03-08');
    expect(daysBetween('2026-03-07', '2026-03-10')).toBe(3);
    expect(daysBetween('2026-10-31', '2026-11-03')).toBe(3);
    expect(validRange('2026-01-02', '2026-01-01')).toBe(false);
  });
  it('navigates month starts and keeps navigation inside supported years', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01');
    expect(shiftMonth('0001-01-01', -1)).toBe('0001-01-01');
    expect(shiftMonth('9999-12-01', 1)).toBe('9999-12-01');
  });
});

function task(key: string, options: Partial<TaskSummary> = {}): TaskSummary {
  return { key, title: key, status: 'planning', childKeys: [], archived: false, parentKey: null, relativeDir: key, revision: '1', ...options };
}
function details(root: TaskSummary, descendants: TaskSummary[]) { return parentTaskDetails(root, new Map([root, ...descendants].map(item => [item.key, item]))); }

it('offers unscheduled active tasks, including child tasks and unknown states', () => {
  const tasks = [task('parent', { childKeys: ['child'] }), task('child', { parentKey: 'parent' }), task('nested-parent', { parentKey: 'parent', childKeys: ['nested'] }), task('independent'), task('done', { status: 'done' }), task('completed', { status: 'completed' }), task('cancelled', { status: 'cancelled' }), task('archived', { archived: true }), task('unknown', { status: 'legacy' }), task('scheduled')];
  expect(pendingTasks(tasks, new Set(['scheduled'])).map(item => item.key)).toEqual(['parent', 'child', 'nested-parent', 'independent', 'unknown']);
});
it('allows dates for active parent and child tasks while keeping cancelled tasks read-only', () => {
  expect(calendarTaskEditable(task('parent', { childKeys: ['child'] }))).toBe(true);
  expect(calendarTaskEditable(task('independent'))).toBe(true);
  expect(calendarTaskEditable(task('child', { parentKey: 'parent' }))).toBe(true);
  expect(calendarTaskEditable(task('nested', { parentKey: 'parent', childKeys: ['leaf'] }))).toBe(true);
  expect(calendarTaskEditable(task('cancelled', { status: 'cancelled' }))).toBe(false);
  expect(calendarTaskEditable(undefined)).toBe(false);
  expect(calendarTaskEditable(task('history', { status: 'completed', archived: true }))).toBe(true);
});
it('preserves multiple child levels and counts only terminal descendants, including archived work in progress', () => {
  const root = task('root', { status: 'completed', childKeys: ['group', 'archived-pending', 'cancelled'] });
  const result = details(root, [task('group', { status: 'completed', childKeys: ['done', 'archive-done'] }), task('done', { status: 'done' }), task('archive-done', { status: 'completed', archived: true }), task('archived-pending', { archived: true }), task('cancelled', { status: 'cancelled', archived: true })]);
  expect(result.rows.map(row => [row.key, row.depth])).toEqual([['group', 0], ['done', 1], ['archive-done', 1], ['archived-pending', 0], ['cancelled', 0]]);
  expect(result.progress).toMatchObject({ completed: 2, total: 3, percent: 66 });
  expect(result.rows.at(-1)?.task).toMatchObject({ status: 'cancelled', archived: true });
});
it('does not claim completion for empty or entirely cancelled children', () => {
  expect(details(task('empty'), []).progress).toMatchObject({ total: 0, completed: 0, percent: 0 });
  expect(details(task('root', { childKeys: ['cancelled'] }), [task('cancelled', { status: 'cancelled' })]).progress).toMatchObject({ total: 0, completed: 0, percent: 0 });
});
it('skips cycles and duplicate edges, keeps missing rows, and does not invent completed leaves', () => {
  const root = task('root', { childKeys: ['group', 'done', 'missing'] });
  const result = details(root, [task('group', { childKeys: ['root', 'done', 'unknown'] }), task('done', { status: 'completed' })]);
  expect(result.rows.map(row => row.key)).toEqual(['group', 'done', 'unknown', 'missing']);
  expect(result.missingCount).toBe(2);
  expect(result.repeatedCount).toBe(2);
  expect(result.progress).toMatchObject({ completed: 1, total: 1 });
  expect(result.rows.find(row => row.key === 'missing')?.task).toBeUndefined();
});
it('projects fresh source states and handles a deep hierarchy without recursive traversal', () => {
  const descendants = Array.from({ length: 2000 }, (_, index) => task(String(index), { childKeys: index < 1999 ? [String(index + 1)] : [], status: 'planning' }));
  const root = task('root', { childKeys: ['0'] });
  const before = details(root, descendants);
  const after = details(root, descendants.map(item => item.key === '1999' ? { ...item, status: 'done' } : item));
  expect(before.rows).toHaveLength(2000);
  expect(before.progress).toMatchObject({ completed: 0, total: 1 });
  expect(after.progress).toMatchObject({ completed: 1, total: 1, percent: 100 });
  expect(before.rows.at(-1)?.task?.status).toBe('planning');
});
