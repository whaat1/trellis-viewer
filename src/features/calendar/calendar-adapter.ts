import type { ScheduleEntry } from '../../generated/contracts';
import { localDate, parseLocalDate, validRange } from './model';

/** Keep a nine-month window containing the requested day within supported years. */
export function calendarWindow(date: string): { start: Date; end: Date } {
  if (!parseLocalDate(date)) throw new Error('月份无效');
  const monthIndex = (Number(date.slice(0, 4)) - 1) * 12 + Number(date.slice(5, 7)) - 1;
  const startIndex = Math.max(0, Math.min(9999 * 12 - 9, monthIndex - 4));
  const start = new Date(0);
  start.setFullYear(Math.floor(startIndex / 12) + 1, startIndex % 12, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 9);
  return { start, end };
}

/** FullCalendar ends are exclusive; saved planner dates include both days. */
export function toCalendarRange(range: Pick<ScheduleEntry, 'startDate' | 'endDate'>): { start: Date; end: Date } {
  if (!validRange(range.startDate, range.endDate)) throw new Error('排期日期无效，请检查开始和结束日期。');
  const start = parseLocalDate(range.startDate)!;
  const end = parseLocalDate(range.endDate)!;
  start.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return { start, end };
}

export function fromCalendarRange(start: Date | null, end: Date | null): { startDate: string; endDate: string } {
  if (!start || !Number.isFinite(start.getTime()) || (end && !Number.isFinite(end.getTime()))) {
    throw new Error('无法读取任务日期，请重新安排。');
  }
  const startDate = localDate(start);
  const lastDay = new Date(end ?? start);
  if (end) lastDay.setDate(lastDay.getDate() - 1);
  const endDate = localDate(lastDay);
  if (!validRange(startDate, endDate)) throw new Error('结束日期不能早于开始日期，任务至少需要一天。');
  return { startDate, endDate };
}
