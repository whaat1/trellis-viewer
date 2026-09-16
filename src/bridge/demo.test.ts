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

  it('schedules parents, children, and independent tasks, and clears legacy dates', async () => {
    const legacy = { id: 'legacy-child', projectId: 'calendar-browser-demo', taskKey: '09-11-task-00001', title: '梳理用户流程', startDate: '2026-09-12', endDate: '2026-09-12' };
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify({ projectColors: {}, schedules: [legacy] }));
    const { demoInvoke } = await import('./demo');
    const dates = { id: null, projectId: legacy.projectId, startDate: '2026-09-12', endDate: '2026-09-14' };
    await demoInvoke('update_task_schedule', { input: { ...dates, taskKey: legacy.taskKey } });
    await demoInvoke('update_task_schedule', { input: { ...legacy, endDate: '2026-09-14' } });
    await demoInvoke('update_task_schedule', { input: { ...dates, taskKey: '09-11-task-00000' } });
    await demoInvoke('update_task_schedule', { input: { ...dates, taskKey: '09-12-independent' } });
    const saved = await demoInvoke<PlannerSettings>('get_planner_settings');
    expect(saved.schedules.map(entry => entry.taskKey)).toEqual([legacy.taskKey, '09-11-task-00000', '09-12-independent']);
    expect(saved.schedules[0]).toEqual({ ...legacy, endDate: '2026-09-14' });
    const cleared = await demoInvoke<PlannerSettings>('update_task_schedule', { input: { ...legacy, startDate: null, endDate: null } });
    expect(cleared.schedules.map(entry => entry.taskKey)).toEqual(['09-11-task-00000', '09-12-independent']);
  });
});

describe('demo project registry', () => {
  it('persists order and removal across reloads and supports reimport', async () => {
    const saved = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation(key => saved.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => { saved.set(key, value); });
    let { demoInvoke } = await import('./demo');
    const ids = ['calendar-browser-demo', 'explicit-browser-demo'];
    await demoInvoke('reorder_projects', { projectIds: ids });
    vi.resetModules();
    ({ demoInvoke } = await import('./demo'));
    expect((await demoInvoke<{ projects: { id: string }[] }>('get_bootstrap')).projects.map(p => p.id)).toEqual(ids);
    await demoInvoke('remove_project', { projectId: ids[1] });
    vi.resetModules();
    ({ demoInvoke } = await import('./demo'));
    expect((await demoInvoke<{ projects: { id: string }[] }>('get_bootstrap')).projects.map(p => p.id)).toEqual([ids[0]]);
    await expect(demoInvoke('activate_project', { projectId: ids[1] })).rejects.toThrow('PROJECT_UNAVAILABLE');
    await demoInvoke('choose_and_add_project');
    expect((await demoInvoke<{ projects: { id: string }[] }>('get_bootstrap')).projects.map(p => p.id)).toEqual(ids);
  });

  it('rejects incomplete, duplicate, and unknown IDs and preserves memory on failed writes', async () => {
    const { demoInvoke } = await import('./demo');
    const initial = await demoInvoke('get_bootstrap');
    const first = 'explicit-browser-demo';
    const second = 'calendar-browser-demo';
    for (const projectIds of [[first], [first, first], [first, 'unknown']]) {
      await expect(demoInvoke('reorder_projects', { projectIds })).rejects.toThrow('INVALID_PROJECT_ORDER');
    }
    await expect(demoInvoke('remove_project', { projectId: 'unknown' })).rejects.toThrow('PROJECT_UNAVAILABLE');
    expect(localStorage.setItem).not.toHaveBeenCalled();
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('storage full'); });
    await expect(demoInvoke('reorder_projects', { projectIds: [second, first] })).rejects.toThrow('storage full');
    await expect(demoInvoke('remove_project', { projectId: first })).rejects.toThrow('storage full');
    expect(await demoInvoke('get_bootstrap')).toEqual(initial);
  });
});
