import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerSettings } from '../generated/contracts';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('explicit demo planner persistence', () => {
  it('leaves memory unchanged when local persistence fails', async () => {
    const { demoInvoke } = await import('./demo');
    const original = await demoInvoke<PlannerSettings>('get_planner_settings');
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('storage full'); });
    await expect(demoInvoke('set_project_color', { projectId: 'explicit-browser-demo', color: '#123456' })).rejects.toThrow('storage full');
    expect(await demoInvoke('get_planner_settings')).toEqual(original);
  });

  it('rejects invalid civil dates and cross-project schedule IDs without changing settings', async () => {
    const { demoInvoke } = await import('./demo');
    const original = await demoInvoke<PlannerSettings>('get_planner_settings');
    const entry = original.schedules[0];
    const input = { id: entry.id, projectId: entry.projectId, taskKey: entry.taskKey, startDate: '2023-02-29', endDate: '2023-03-02' };
    await expect(demoInvoke('update_task_schedule', { input })).rejects.toThrow('起止日期');
    await expect(demoInvoke('update_task_schedule', { input: { ...input, projectId: 'calendar-browser-demo', startDate: null, endDate: null } })).rejects.toThrow('其他项目');
    expect(await demoInvoke('get_planner_settings')).toEqual(original);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('schedules top-level parents and independent tasks, rejects children, and clears legacy dates', async () => {
    const legacy = { id: 'legacy-child', projectId: 'calendar-browser-demo', taskKey: '09-11-task-00001', title: '梳理用户流程', startDate: '2026-09-12', endDate: '2026-09-12' };
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify({ projectColors: {}, schedules: [legacy] }));
    const { demoInvoke } = await import('./demo');
    const dates = { id: null, projectId: legacy.projectId, startDate: '2026-09-12', endDate: '2026-09-14' };
    await expect(demoInvoke('update_task_schedule', { input: { ...dates, taskKey: legacy.taskKey } })).rejects.toThrow('父任务或独立任务');
    await expect(demoInvoke('update_task_schedule', { input: { ...legacy, endDate: '2026-09-14' } })).rejects.toThrow('父任务或独立任务');
    await demoInvoke('update_task_schedule', { input: { ...dates, taskKey: '09-11-task-00000' } });
    await demoInvoke('update_task_schedule', { input: { ...dates, taskKey: '09-12-independent' } });
    const saved = await demoInvoke<PlannerSettings>('get_planner_settings');
    expect(saved.schedules.map(entry => entry.taskKey)).toEqual([legacy.taskKey, '09-11-task-00000', '09-12-independent']);
    expect(saved.schedules[0]).toEqual(legacy);
    const cleared = await demoInvoke<PlannerSettings>('update_task_schedule', { input: { ...legacy, startDate: null, endDate: null } });
    expect(cleared.schedules.map(entry => entry.taskKey)).toEqual(['09-11-task-00000', '09-12-independent']);
  });
});


it('demo removal and re-add preserve project identity and settings', async () => {
  const { demoInvoke } = await import('./demo');
  const original = await demoInvoke<PlannerSettings>('get_planner_settings');
  await demoInvoke('remove_project', { projectId: 'explicit-browser-demo' });
  const removed = await demoInvoke<{ projects: { id: string }[] }>('get_bootstrap');
  expect(removed.projects.some(project => project.id === 'explicit-browser-demo')).toBe(false);
  await demoInvoke('choose_and_add_project');
  const restored = await demoInvoke<{ projects: { id: string }[] }>('get_bootstrap');
  expect(restored.projects.some(project => project.id === 'explicit-browser-demo')).toBe(true);
  expect(await demoInvoke('get_planner_settings')).toEqual(original);
});
