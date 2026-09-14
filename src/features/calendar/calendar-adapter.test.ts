import { describe, expect, it } from 'vitest';
import { calendarWindow, fromCalendarRange, toCalendarRange } from './calendar-adapter';
import { localDate, parseLocalDate } from './model';

describe('FullCalendar date boundary', () => {
  it.each([
    ['2026-09-12', '2026-05-01', '2027-02-01'],
    ['0001-01-01', '0001-01-01', '0001-10-01'],
    ['9999-12-31', '9999-04-01', '10000-01-01'],
  ])('keeps a bounded nine-month window containing %s', (date, start, end) => {
    const range = calendarWindow(date);
    expect(localDate(range.start)).toBe(start);
    expect(localDate(range.end)).toBe(end);
    const target = parseLocalDate(date)!;
    expect(target >= range.start && target < range.end).toBe(true);
    expect(range.start.getHours()).toBe(0);
    expect(range.end.getHours()).toBe(0);
  });
  it('keeps a one-day schedule visible for exactly that civil day', () => {
    const stored = { startDate: '2026-09-12', endDate: '2026-09-12' };
    const calendar = toCalendarRange(stored);
    expect(localDate(calendar.start)).toBe('2026-09-12');
    expect(localDate(calendar.end)).toBe('2026-09-13');
    expect(calendar.start.getHours()).toBe(0);
    expect(calendar.end.getHours()).toBe(0);
    expect(fromCalendarRange(calendar.start, calendar.end)).toEqual(stored);
  });
  it('saves the resized inclusive end rather than an extra day', () => {
    const original = toCalendarRange({ startDate: '2026-09-29', endDate: '2026-10-03' });
    const resizedEnd = parseLocalDate('2026-10-07')!;
    const originalEndTime = resizedEnd.getTime();
    expect(fromCalendarRange(original.start, resizedEnd)).toEqual({ startDate: '2026-09-29', endDate: '2026-10-06' });
    expect(resizedEnd.getTime()).toBe(originalEndTime);
    const shortened = parseLocalDate('2026-09-30')!;
    expect(fromCalendarRange(original.start, shortened)).toEqual({ startDate: '2026-09-29', endDate: '2026-09-29' });
  });
  it.each([
    ['2026-03-07', '2026-03-09'],
    ['2026-10-31', '2026-11-02'],
    ['2024-02-28', '2024-02-29'],
    ['2026-12-31', '2027-01-03'],
    ['0001-01-01', '0001-01-01'],
    ['9999-12-31', '9999-12-31'],
  ])('round-trips %s–%s across civil-date boundaries', (startDate, endDate) => {
    const calendar = toCalendarRange({ startDate, endDate });
    expect(fromCalendarRange(calendar.start, calendar.end)).toEqual({ startDate, endDate });
  });
  it('treats an external task without an end as a single day', () => {
    expect(fromCalendarRange(parseLocalDate('2026-09-12'), null)).toEqual({ startDate: '2026-09-12', endDate: '2026-09-12' });
  });
  it('rejects missing, invalid, reversed, and empty ranges before persistence', () => {
    expect(() => fromCalendarRange(null, null)).toThrow();
    expect(() => fromCalendarRange(new Date(NaN), null)).toThrow();
    expect(() => fromCalendarRange(parseLocalDate('2026-09-12'), new Date(NaN))).toThrow();
    expect(() => fromCalendarRange(parseLocalDate('2026-09-12'), parseLocalDate('2026-09-12'))).toThrow();
    expect(() => toCalendarRange({ startDate: '2026-02-29', endDate: '2026-03-01' })).toThrow();
  });
});
