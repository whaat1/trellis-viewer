import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProject, PlannerSettings, ScheduleEntry, TaskSummary } from '../generated/contracts';

const mocks = vi.hoisted(() => ({ plannerSettings: vi.fn(), calendarProject: vi.fn(), setProjectColor: vi.fn(), updateTaskSchedule: vi.fn() }));
vi.mock('../bridge/api', () => ({ api: mocks, errorText: String }));
let planner: typeof import('./planner');
const empty = (): PlannerSettings => ({ projectColors: {}, schedules: [] });
const entry: ScheduleEntry = { id: 'schedule-1', projectId: 'project-1', taskKey: 'tasks/feature', title: 'Feature', startDate: '2026-09-12', endDate: '2026-09-14' };
const task = (key: string, title = 'Feature'): TaskSummary => ({ key, title, status: 'planning', relativeDir: key, parentKey: null, childKeys: [], archived: key.includes('archive'), revision: '1' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  planner = await import('./planner');
});

describe('project identity and archived schedules', () => {
  it('keeps default colors stable and uses saved colors', () => {
    const original = planner.getProjectColor('project-1', empty());
    expect(planner.projectPalette).toContain(original);
    expect(planner.getProjectColor('project-1', { projectColors: { other: '#000000' }, schedules: [] })).toBe(original);
    expect(planner.getProjectColor('project-1', { projectColors: { 'project-1': '#AABBCC' }, schedules: [] })).toBe('#AABBCC');
  });
  it('prefers exact paths and recovers only an unambiguous moved directory', () => {
    const exact = task(entry.taskKey);
    const moved = task('tasks/archive/2026-09/feature');
    expect(planner.resolveScheduledTask(entry, [moved, exact])).toBe(exact);
    expect(planner.resolveScheduledTask(entry, [moved])).toBe(moved);
    expect(planner.resolveScheduledTask(entry, [moved, task('tasks/archive/2026-08/feature')])).toBeUndefined();
    expect(planner.resolveScheduledTask(entry, [task('tasks/unrelated', entry.title)])).toBeUndefined();
  });
});

describe('durable planner saves', () => {
  it('serializes color and schedule saves without replacing either change', async () => {
    const color = deferred<PlannerSettings>();
    const schedule = deferred<PlannerSettings>();
    mocks.setProjectColor.mockReturnValue(color.promise);
    mocks.updateTaskSchedule.mockReturnValue(schedule.promise);
    const first = planner.setProjectColor('project-1', '#608e75');
    const second = planner.updateSchedule({ ...entry, id: null });
    await Promise.resolve();
    expect(mocks.setProjectColor).toHaveBeenCalledOnce();
    expect(mocks.updateTaskSchedule).not.toHaveBeenCalled();
    expect(planner.usePlanner.getState().settings).toEqual(empty());
    const savedColor = { projectColors: { 'project-1': '#608e75' }, schedules: [] };
    color.resolve(savedColor);
    await first;
    await Promise.resolve();
    expect(mocks.updateTaskSchedule).toHaveBeenCalledOnce();
    expect(planner.usePlanner.getState().saving).toBe(true);
    schedule.resolve({ ...savedColor, schedules: [entry] });
    await second;
    expect(planner.usePlanner.getState().settings).toEqual({ ...savedColor, schedules: [entry] });
    expect(planner.usePlanner.getState().saving).toBe(false);
  });
  it('does not let an older settings read overwrite a saved color', async () => {
    const old = deferred<PlannerSettings>();
    mocks.plannerSettings.mockReturnValue(old.promise);
    const reading = planner.loadPlannerSettings();
    const saved = { projectColors: { 'project-1': '#608e75' }, schedules: [] };
    mocks.setProjectColor.mockResolvedValue(saved);
    await planner.setProjectColor('project-1', '#608e75');
    old.resolve(empty());
    await reading;
    expect(planner.usePlanner.getState().settings).toEqual(saved);
  });
  it('ignores a stale read error after a successful save', async () => {
    const old = deferred<PlannerSettings>();
    mocks.plannerSettings.mockReturnValue(old.promise);
    const reading = planner.loadPlannerSettings();
    mocks.setProjectColor.mockResolvedValue({ projectColors: { 'project-1': '#608e75' }, schedules: [] });
    await planner.setProjectColor('project-1', '#608e75');
    old.reject(new Error('old read failed'));
    await reading;
    expect(planner.usePlanner.getState().error).toBe('');
    expect(planner.usePlanner.getState().settingsError).toBe('');
  });
  it('preserves settings on failure and allows the next queued save', async () => {
    const original = { projectColors: {}, schedules: [entry] };
    planner.usePlanner.setState({ settings: original });
    mocks.setProjectColor.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({ ...original, projectColors: { 'project-1': '#648ec4' } });
    await expect(planner.setProjectColor('project-1', '#608e75')).rejects.toThrow('disk full');
    expect(planner.usePlanner.getState().settings).toEqual(original);
    expect(planner.usePlanner.getState().error).toContain('disk full');
    await planner.setProjectColor('project-1', '#648ec4');
    expect(planner.usePlanner.getState().settings).toEqual({ ...original, projectColors: { 'project-1': '#648ec4' } });
    expect(planner.usePlanner.getState().error).toBe('');
    expect(planner.usePlanner.getState().saving).toBe(false);
  });
});

describe('calendar refresh isolation', () => {
  it('does not hide a settings failure when project metadata loads', async () => {
    mocks.plannerSettings.mockRejectedValue(new Error('invalid planner config'));
    await planner.loadPlannerSettings();
    mocks.calendarProject.mockResolvedValue({ projectId: 'project-1', tasks: [], diagnostics: [] });
    await planner.loadCalendar([{ id: 'project-1', name: 'Project', path: '/project' }]);
    expect(planner.usePlanner.getState().settingsError).toContain('invalid planner config');
  });
  it('rejects an obsolete refresh error after newer metadata arrives', async () => {
    const old = deferred<CalendarProject>();
    const latest = { projectId: 'project-1', tasks: [task('tasks/new')], diagnostics: [] };
    mocks.calendarProject.mockReturnValueOnce(old.promise).mockResolvedValueOnce(latest);
    const reading = planner.refreshCalendarProject('project-1');
    await planner.refreshCalendarProject('project-1');
    old.reject(new Error('outdated project read'));
    await reading;
    expect(planner.usePlanner.getState().projectData['project-1']).toEqual(latest);
    expect(planner.usePlanner.getState().error).toBe('');
  });
});
