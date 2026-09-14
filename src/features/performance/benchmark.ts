import { api, metrics, nativeMode, demoMode, errorText } from '../../bridge/api';
import { useStore, activateProject, selectRoot, setFilter, ensureTree, selectDocument } from '../../state/store';
import { statuses } from '../../state/model';
import { SamplingSession, type SamplingEvidence } from './sampling';
export interface Summary { count: number; p50: number; p95: number; p99: number; max: number }
export function summarize(values: number[]): Summary {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { count: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? 0 };
}
export interface BenchmarkOptions { requestFocus?: boolean; scrollSeconds?: number; selections?: number; allProjects?: boolean }
export interface ReadingAnchor { key: string; offsetPx: number }
export interface RefreshPreservationReport {
  status: 'passed' | 'failed' | 'notExercised'; reason: string; observedRevisionChange: boolean; waitMs: number;
  revisionBefore: string | null; revisionAfter: string | null; anchorBefore: ReadingAnchor | null; anchorAfter: ReadingAnchor | null;
  anchorPreserved: boolean | null; offsetDeltaPx: number | null; selectionPreserved: boolean | null; expansionPreserved: boolean | null;
  frameGapMs: Summary; gapsOver50Ms: number[];
}
export interface ProjectReport {
  projectId: string; projectName: string; taskCount: number; rootCount: number; scanMs: number; activationMs: number; activationMeasured: boolean; snapshotInstallMs: number;
  dispatchToFrameMs: Summary; interactionFrameGapMs: Summary; documentFrameGapMs: Summary; interactionGapsOver50Ms: number[]; documentGapsOver50Ms: number[]; baseline64kReadyMs: Summary; staleSwitch: { readyMs: number | null; stayedOnNewDocument: boolean }; foregroundFrameGapMs: Summary; frameGapsOver50Ms: number[]; hiddenSamples: number; scrollSeconds: number;
  refreshPreservation: RefreshPreservationReport;
  documentCases: { key: string; readyMs: number | null; parseMs: number | null; parseReused: boolean | null; readMs: number | null; sourceBytes: number | null; status: string }[]; counters: Record<string, number>; scrollCounters: Record<string, number>; mountedTaskCardsMax: number; mountedMarkdownBlocksMax: number;
}
export interface PerfReport { status: 'completed' | 'aborted'; error: string | null; abortedPhase: string | null; sampling: SamplingEvidence; version: number; runtime: string; userAgent: string; startedAt: string; completedAt: string; viewport: { width: number; height: number; dpr: number }; projects: ProjectReport[]; limitations: string[]; path?: string }
let running = false;
let latest: PerfReport | null = null;
let currentProgress = '';
const listeners = new Set<() => void>();
export const performanceState = { subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => ({ running, latest, progress: currentProgress }) };
function notify(progress: string) { currentProgress = progress; for (const listener of listeners) listener(); }
let activeSampling: SamplingSession | null = null;
const frameMonitors = new Set<() => number[]>();
const frame = () => { if (!activeSampling) throw new Error('Sampling session is not initialized'); return activeSampling.frame(); };
const painted = async () => { await frame(); await frame(); };
async function until(check: () => boolean, timeout: number) { const start = performance.now(); while (!check()) { activeSampling?.assertForeground(); if (performance.now() - start > timeout) return false; await new Promise(resolve => setTimeout(resolve, 20)); } return true; }
function monitorFrames() {
  const gaps: number[] = []; let previous = 0; let id = 0;
  function tick(now: number) { const eligible = activeSampling?.eligible(); if (previous && eligible) gaps.push(now - previous); previous = eligible ? now : 0; id = requestAnimationFrame(tick); }
  id = requestAnimationFrame(tick);
  const stop = () => { cancelAnimationFrame(id); frameMonitors.delete(stop); return gaps; };
  frameMonitors.add(stop); return stop;
}
async function openReady(projectId: string, taskKey: string, key: string, timeout = 20000): Promise<number | null> {
  const before = metrics.documentReadyCount; const start = performance.now();
  const identity = `${projectId}:${taskKey}:${key}`;
  const state = useStore.getState();
  const alreadyReady = state.projectId === projectId && state.selectedDoc?.taskKey === taskKey && state.selectedDoc.key === key && metrics.documentReadyIdentity === identity && document.querySelector<HTMLElement>('[data-perf-scroll="document"]')?.dataset.documentIdentity === identity;
  selectDocument(taskKey, key);
  const done = await until(() => (alreadyReady || metrics.documentReadyCount > before) && metrics.documentReadyIdentity === identity, timeout);
  return done ? performance.now() - start : null;
}
function readingAnchor(element: HTMLElement): ReadingAnchor | null {
  const viewport = element.getBoundingClientRect();
  const top = viewport.top + element.clientTop;
  const block = Array.from(element.querySelectorAll<HTMLElement>('[data-block-key]')).find(node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > top && rect.top < top + element.clientHeight;
  });
  return block?.dataset.blockKey ? { key: block.dataset.blockKey, offsetPx: top - block.getBoundingClientRect().top } : null;
}
async function verifyRefreshPreservation(projectId: string, taskKey: string, documentKey: string | undefined): Promise<RefreshPreservationReport> {
  const result: RefreshPreservationReport = { status: 'notExercised', reason: 'long document unavailable', observedRevisionChange: false, waitMs: 0, revisionBefore: null, revisionAfter: null, anchorBefore: null, anchorAfter: null, anchorPreserved: null, offsetDeltaPx: null, selectionPreserved: null, expansionPreserved: null, frameGapMs: summarize([]), gapsOver50Ms: [] };
  if (!documentKey) return result;
  const identity = `${projectId}:${taskKey}:${documentKey}`;
  const element = document.querySelector<HTMLElement>('[data-perf-scroll="document"]');
  if (!element || element.dataset.documentIdentity !== identity) return { ...result, reason: 'long document did not become readable' };
  // Position once, then leave scrollTop untouched until after the comparison.
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight) / 2;
  await painted(); await painted();
  result.anchorBefore = readingAnchor(element);
  result.revisionBefore = element.dataset.documentRevision ?? null;
  if (!result.anchorBefore || !result.revisionBefore) return { ...result, reason: 'visible anchor unavailable' };
  const before = useStore.getState();
  const selectedBefore = JSON.stringify(before.selectedDoc);
  const expandedBefore = JSON.stringify([...before.expanded].sort());
  const readyBefore = metrics.documentReadyCount;
  let stayedVisible = document.visibilityState === 'visible';
  const stopFrames = monitorFrames();
  const started = performance.now();
  const changed = await until(() => {
    stayedVisible &&= document.visibilityState === 'visible';
    return element.dataset.documentIdentity === identity && !!element.dataset.documentRevision && element.dataset.documentRevision !== result.revisionBefore && metrics.documentReadyCount > readyBefore;
  }, 5000);
  result.waitMs = performance.now() - started;
  if (changed) await painted();
  const gaps = stopFrames();
  result.frameGapMs = summarize(gaps); result.gapsOver50Ms = gaps.filter(ms => ms >= 50);
  result.revisionAfter = element.dataset.documentRevision ?? null;
  result.observedRevisionChange = changed;
  if (!changed) return { ...result, reason: 'no committed external document revision observed within 5 seconds' };
  if (!stayedVisible) return { ...result, reason: 'window visibility changed during stationary observation' };
  result.anchorAfter = readingAnchor(element);
  result.offsetDeltaPx = result.anchorAfter?.key === result.anchorBefore.key ? result.anchorAfter.offsetPx - result.anchorBefore.offsetPx : null;
  result.anchorPreserved = result.offsetDeltaPx !== null && Math.abs(result.offsetDeltaPx) <= 2;
  const after = useStore.getState();
  result.selectionPreserved = after.projectId === projectId && JSON.stringify(after.selectedDoc) === selectedBefore;
  result.expansionPreserved = JSON.stringify([...after.expanded].sort()) === expandedBefore;
  result.status = result.anchorPreserved && result.selectionPreserved && result.expansionPreserved ? 'passed' : 'failed';
  result.reason = result.status === 'passed' ? 'external revision committed with same first visible block, offset within 2 px, selection and expansion' : 'external revision committed but reading state changed';
  return result;
}

function counters() { return { ipcCalls: metrics.ipcCalls, patchCount: metrics.patchCount, upserts: metrics.upserts, documentInvalidations: metrics.documentInvalidations, markdownParses: metrics.markdownParses, markdownCommits: metrics.markdownCommits, staleResponses: metrics.staleResponses }; }
export async function runBenchmark(options: BenchmarkOptions = {}): Promise<PerfReport> {
  if (running) throw new Error('性能采样正在进行');
  running = true; notify('正在准备真实数据…');
  const startedAt = new Date().toISOString();
  const projects = options.allProjects ? useStore.getState().projects : useStore.getState().projects.filter(project => project.id === useStore.getState().projectId);
  const reports: ProjectReport[] = [];
  const scrollSeconds = Math.max(3, Math.min(120, options.scrollSeconds ?? 60));
  const selections = Math.max(10, Math.min(500, options.selections ?? 100));
  const session = new SamplingSession({ focus: options.requestFocus === false ? async () => {} : api.focusWindow, focused: api.windowFocused, onFocus: api.subscribeWindowFocus, visible: () => document.visibilityState === 'visible', onVisibility: handler => { document.addEventListener('visibilitychange', handler); return () => document.removeEventListener('visibilitychange', handler); } });
  activeSampling = session;
  const makeReport = (status: 'completed' | 'aborted', error: string | null): PerfReport => ({ version: 2, status, error, abortedPhase: status === 'aborted' ? currentProgress : null, sampling: { ...session.evidence, failures: [...session.evidence.failures] }, runtime: nativeMode ? 'Tauri WKWebView (real filesystem IPC)' : demoMode ? 'Browser EXPLICIT DEMO — not native evidence' : 'Unsupported browser', userAgent: navigator.userAgent, startedAt, completedAt: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, projects: reports, limitations: [ 'dispatchToFrameMs is programmatic state dispatch to two requestAnimationFrame callbacks; it excludes physical-input queueing and is not native input latency.', 'Sampling requests focus once, verifies native isFocused plus document visibility, subscribes to focus loss and checks focus every500ms; any observed loss or2s frame timeout aborts the run. Native focus does not prove unobscured pixels. rAF indicates scheduling gaps, not painted FPS.', 'refreshPreservation compares a stationary visible block and offset after an actual committed revision; absent external changes are notExercised. Its frame gaps are observation-stage scheduling gaps, not attributed main-thread work.', 'External fixture writer must run separately; patch and documentInvalidation counters show observed updates, not exact write-to-visible latency.', '64KiB ready measurements use 20 repeated real reads and Worker parses; other document cases are single samples. activationMs only measures a new activation when activationMeasured=true and is never process cold start. Cold-start repetitions, process CPU/memory, 10-minute soak and physical input traces require external measurement.', 'Local/remote images use accessible placeholders in P0; external links are not opened.' ] });
  try {
    notify('正在激活应用窗口并核对前台状态…');
    await session.start();
    if (!projects.length) throw new Error('没有可测量的当前项目');
    for (const project of projects) {
      notify(`${project.name} · 读取项目索引`);
      const activationStart = performance.now();
      const activationMeasured = useStore.getState().projectId !== project.id || !useStore.getState().index;
      if (activationMeasured) await activateProject(project.id);
      const activationMs = performance.now() - activationStart;
      const initial = useStore.getState();
      if (!initial.index) throw new Error(initial.error || '没有可测任务索引');
      const roots = initial.index.rootKeys;
      if (!roots.length) throw new Error('该项目没有任务，无法进行交互采样');
      const before = counters();
      const dispatchTimes: number[] = [];
      const stopInteraction = monitorFrames();
      notify(`${project.name} · ${selections} 次程序化任务／筛选反馈`);
      for (let i = 0; i < selections; i++) {
        const start = performance.now();
        if (i % 2 === 0) setFilter(statuses[(i / 2) % statuses.length][0]);
        else selectRoot(roots[(i * 17) % roots.length]);
        await painted(); dispatchTimes.push(performance.now() - start);
      }
      const interactionGaps = stopInteraction();
      const stopDocuments = monitorFrames();
      setFilter('all');
      const first = roots.find(key => key.endsWith('09-11-task-00000')) ?? roots[0];
      selectRoot(first); await ensureTree(first);
      const docs = useStore.getState().docs[first] ?? [];
      const documentCases: ProjectReport['documentCases'] = [];
      const baseline = docs.find(doc => doc.path === 'baseline-64k.md');
      const short = docs.find(doc => doc.path === 'research/nested/notes.md') ?? docs.find(doc => doc.path === 'prd.md');
      const baselineTimes: number[] = [];
      if (baseline && short) {
        notify(`${project.name} · 20 次 64KiB 正文可读采样`);
        for (let i = 0; i < 20; i++) {
          await openReady(project.id, first, short.key);
          const readyMs = await openReady(project.id, first, baseline.key);
          if (readyMs !== null) baselineTimes.push(readyMs);
        }
      }
      for (const name of ['baseline-64k.md', 'long-paragraphs.md', 'long-table.md', 'long-code.md', 'images.md']) {
        const entry = docs.find(doc => doc.path === name);
        if (!entry) continue;
        notify(`${project.name} · 文档 ${name}`);
        const parsesBefore = metrics.markdownParses;
        const readyMs = await openReady(project.id, first, entry.key);
        const done = readyMs !== null;
        documentCases.push({ key: name, readyMs, parseMs: done && metrics.markdownParses > parsesBefore ? metrics.lastDocumentParseMs : null, parseReused: done ? metrics.markdownParses === parsesBefore : null, readMs: done ? metrics.lastDocumentReadMs : null, sourceBytes: done ? metrics.lastDocumentSourceBytes : null, status: done ? 'rendered' : 'timeout' });
        const element = document.querySelector<HTMLElement>('[data-perf-scroll="document"]');
        if (done && element) { element.scrollTop = Math.min(1200, element.scrollHeight / 3); await painted(); }
      }
      const long = docs.find(doc => doc.path === 'long-paragraphs.md') ?? docs[0];
      const table = docs.find(doc => doc.path === 'long-table.md');
      let staleSwitch: ProjectReport['staleSwitch'] = { readyMs: null, stayedOnNewDocument: false };
      if (table && short) {
        notify(`${project.name} · 大文档解析中切换短文档`);
        selectDocument(first, table.key);
        await painted();
        const readyMs = await openReady(project.id, first, short.key);
        await new Promise(resolve => setTimeout(resolve, 200));
        staleSwitch = { readyMs, stayedOnNewDocument: metrics.documentReadyIdentity === `${project.id}:${first}:${short.key}` && useStore.getState().selectedDoc?.key === short.key };
      }
      if (long) await openReady(project.id, first, long.key);
      const documentGaps = stopDocuments();
      notify(`${project.name} · 静止阅读，等待外部文档更新（最多 5 秒）`);
      const refreshPreservation = await verifyRefreshPreservation(project.id, first, docs.find(doc => doc.path === 'long-paragraphs.md')?.key);
      notify(`${project.name} · 前台滚动 ${scrollSeconds} 秒（请保持窗口可见）`);
      const gaps: number[] = []; let hiddenSamples = 0; let maxCards = 0; let maxBlocks = 0;
      const scrollCountersBefore = counters();
      const scrollStart = performance.now(); let previous = await frame(); let sample = 0; let previousVisible = document.visibilityState === 'visible';
      while (performance.now() - scrollStart < scrollSeconds * 1000) {
        const now = await frame();
        const visible = session.eligible();
        if (visible) {
          if (previousVisible) gaps.push(now - previous); else hiddenSamples++;
          const elapsed = now - scrollStart;
          const cardScroll = document.querySelector<HTMLElement>('[data-perf-scroll="tasks"]');
          const documentScroll = document.querySelector<HTMLElement>('[data-perf-scroll="document"]');
          if (cardScroll) cardScroll.scrollTop = Math.max(0, cardScroll.scrollHeight - cardScroll.clientHeight) * (1 - Math.cos(elapsed / 1600)) / 2;
          if (documentScroll) documentScroll.scrollTop = Math.max(0, documentScroll.scrollHeight - documentScroll.clientHeight) * (1 - Math.cos(elapsed / 4500)) / 2;
          if (sample++ % 30 === 0) { maxCards = Math.max(maxCards, document.querySelectorAll('[data-task-key]').length); maxBlocks = Math.max(maxBlocks, document.querySelectorAll('.markdown-block').length); }
        } else hiddenSamples++;
        previous = now; previousVisible = visible;
      }
      const after = counters(); const diff: Record<string, number> = {}; const scrollCounters: Record<string, number> = {};
      for (const key of Object.keys(after) as (keyof typeof after)[]) { diff[key] = after[key] - before[key]; scrollCounters[key] = after[key] - scrollCountersBefore[key]; }
      reports.push({ projectId: project.id, projectName: project.name, taskCount: Object.keys(initial.index.tasks).length, rootCount: roots.length, scanMs: initial.scanMs, activationMs, activationMeasured, snapshotInstallMs: metrics.snapshotInstallMs, dispatchToFrameMs: summarize(dispatchTimes), interactionFrameGapMs: summarize(interactionGaps), documentFrameGapMs: summarize(documentGaps), interactionGapsOver50Ms: interactionGaps.filter(ms => ms >= 50), documentGapsOver50Ms: documentGaps.filter(ms => ms >= 50), baseline64kReadyMs: summarize(baselineTimes), staleSwitch, foregroundFrameGapMs: summarize(gaps), frameGapsOver50Ms: gaps.filter(ms => ms >= 50), hiddenSamples, scrollSeconds, documentCases, refreshPreservation, counters: diff, scrollCounters, mountedTaskCardsMax: maxCards, mountedMarkdownBlocksMax: maxBlocks });
    }
    session.assertForeground();
    latest = makeReport('completed', null);
    latest.path = await api.saveReport(latest);
    notify(`采样完成 · ${latest.path}`);
    return latest;
  } catch (failure) {
    latest = makeReport('aborted', errorText(failure));
    try { latest.path = await api.saveReport(latest); }
    catch (saveFailure) { notify(`采样已停止，报告保存失败：${errorText(saveFailure)}`); throw saveFailure; }
    notify(`采样无效，已保存原因：${latest.error} · ${latest.path}`);
    return latest;
  } finally { session.stop(); activeSampling = null; for (const stop of [...frameMonitors]) stop(); running = false; for (const listener of listeners) listener(); }
}
declare global { interface Window { __TRELLIS_PERF__: { run: typeof runBenchmark; state: typeof performanceState.snapshot; metrics: typeof metrics; getStore: typeof useStore.getState } } }
window.__TRELLIS_PERF__ = { run: runBenchmark, state: performanceState.snapshot, metrics, getStore: useStore.getState };
