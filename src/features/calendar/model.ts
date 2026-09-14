import type { TaskSummary } from '../../generated/contracts';
import { projectProgress } from '../../state/model';

/** Calendar dates are local civil dates, never UTC timestamps. */
export function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
export function localDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// Gregorian civil-day ordinal avoids subtracting local timestamps across DST.
function ordinal(value: string): number {
  const date = parseLocalDate(value);
  if (!date) throw new Error('日期无效');
  let year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
}
export function daysBetween(start: string, end: string): number { return ordinal(end) - ordinal(start); }
export function validRange(start: string, end: string): boolean { return !!parseLocalDate(start) && !!parseLocalDate(end) && start <= end; }
export function shiftMonth(month: string, amount: number): string {
  const date = parseLocalDate(month);
  if (!date) throw new Error('月份无效');
  date.setDate(1); date.setMonth(date.getMonth() + amount);
  return date.getFullYear() < 1 || date.getFullYear() > 9999 ? `${month.slice(0, 7)}-01` : localDate(date);
}
export function pendingTasks(tasks: TaskSummary[], scheduledKeys: ReadonlySet<string>) {
  return tasks.filter(task => task.parentKey === null && !task.archived && !['completed', 'done', 'cancelled'].includes(task.status) && !scheduledKeys.has(task.key));
}

export interface CalendarChildRow {
  key: string;
  depth: number;
  task?: TaskSummary;
}
export interface ParentTaskDetails {
  rows: CalendarChildRow[];
  progress: ReturnType<typeof projectProgress>;
  missingCount: number;
  repeatedCount: number;
}
/** Walk each descendant once without recursion, retaining source hierarchy.
 * A missing edge never turns a grouping task into completed executable work. */
export function parentTaskDetails(parent: TaskSummary, taskMap: ReadonlyMap<string, TaskSummary>): ParentTaskDetails {
  const rows: CalendarChildRow[] = [];
  const descendants: Record<string, TaskSummary> = Object.create(null);
  const seen = new Set([parent.key]);
  const stack = [...parent.childKeys].reverse().map(key => ({ key, depth: 0 }));
  let missingCount = 0;
  let repeatedCount = 0;
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.key)) { repeatedCount++; continue; }
    seen.add(row.key);
    const task = taskMap.get(row.key);
    rows.push({ ...row, task });
    if (!task) { missingCount++; continue; }
    descendants[task.key] = task;
    for (let index = task.childKeys.length - 1; index >= 0; index--) stack.push({ key: task.childKeys[index], depth: row.depth + 1 });
  }
  return { rows, progress: projectProgress(descendants), missingCount, repeatedCount };
}
export function calendarTaskEditable(task?: TaskSummary): boolean {
  return !!task && task.parentKey === null && task.status !== 'cancelled';
}
