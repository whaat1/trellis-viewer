import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ focus: vi.fn(async () => {}), save: vi.fn(async () => '/app/report.json') }));
vi.mock('../../bridge/api', () => ({
  nativeMode: true, demoMode: false, errorText: (error: Error) => error.message, metrics: {},
  api: { focusWindow: mocks.focus, windowFocused: async () => true, subscribeWindowFocus: async () => () => {}, saveReport: mocks.save },
}));
vi.mock('../../state/store', () => ({
  useStore: { getState: () => ({ projects: [{ id: 'p', name: 'project' }], projectId: 'p', index: { rootKeys: ['t'], tasks: { t: {} } } }) },
  activateProject: vi.fn(), selectRoot: vi.fn(), setFilter: vi.fn(), ensureTree: vi.fn(), selectDocument: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
it('saves an explicit invalid report when foreground frame callbacks stop', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('navigator', { userAgent: 'test' });
  vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800); vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const { runBenchmark, performanceState } = await import('./benchmark');
  const pending = runBenchmark();
  await vi.advanceTimersByTimeAsync(2200);
  const report = await pending;
  expect(report.status).toBe('aborted');
  expect(report.sampling.valid).toBe(false);
  expect(report.error).toContain('FRAME_TIMEOUT');
  expect(report.projects).toEqual([]);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'aborted' }));
  expect(report.path).toBe('/app/report.json');
  expect(performanceState.snapshot().running).toBe(false);
});
