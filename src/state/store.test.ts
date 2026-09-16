import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Changes, DocEntry, Invalidated, Snapshot } from '../generated/contracts';
const mocks = vi.hoisted(() => ({ activate: vi.fn(), tree: vi.fn(), bootstrap: vi.fn(), subscribe: vi.fn(), changes: vi.fn(), snapshot: vi.fn(), removeProject: vi.fn(), addProject: vi.fn() }));
vi.mock('../bridge/api', () => ({ api: mocks, errorText: String, metrics: { staleResponses: 0, snapshotInstallMs: 0, patchCount: 0, upserts: 0, documentInvalidations: 0 } }));
import { addProject, activateProject, removeProject, ensureTree, initialize, selectDocument, selectRoot, toggleExpanded, useStore } from './store';
function snapshot(projectId: string): Snapshot { return { projectId, epoch: 'session', revision: 1, tasks: [{ key: 'parent', title: 'Parent', status: 'planning', relativeDir: 'parent', parentKey: null, childKeys: ['child'], archived: false, revision: '1' }, { key: 'child', title: 'Child', status: 'planning', relativeDir: 'child', parentKey: 'parent', childKeys: [], archived: false, revision: '1' }], rootKeys: ['parent'], scanMs: 0, diagnostics: [] }; }
beforeEach(() => { vi.clearAllMocks(); mocks.activate.mockImplementation(async (id: string) => snapshot(id)); mocks.tree.mockResolvedValue([]); useStore.setState({ projectId: '', index: null, selectedDoc: null, rootKey: '', docs: {}, expanded: new Set(), documentVersions: {}, documentReset: 0, treeVersions: {}, pendingRootKey: null, loading: false, error: '' }); });
describe('resource races', () => {
  it('restores a remembered document only after the backend activation commits', async () => {
    await activateProject('remembered');
    selectDocument('parent', 'prd.md');
    await activateProject('elsewhere');
    let finish!: (value: Snapshot) => void;
    mocks.activate.mockImplementation(() => new Promise<Snapshot>(resolve => { finish = resolve; }));
    mocks.tree.mockResolvedValue([{ key: 'prd.md', path: 'prd.md', name: 'prd.md' }]);
    const activating = activateProject('remembered');
    expect(useStore.getState().selectedDoc).toBeNull();
    finish(snapshot('remembered'));
    await activating;
    expect(useStore.getState().selectedDoc).toEqual({ taskKey: 'parent', key: 'prd.md' });
  });
  it('does not install a late document tree from the first A activation after A → B → A', async () => {
    await activateProject('A');
    let finish!: (entries: DocEntry[]) => void;
    mocks.tree.mockImplementation((_projectId: string, taskKey: string) => taskKey === 'child' ? new Promise<DocEntry[]>(resolve => { finish = resolve; }) : Promise.resolve([]));
    const stale = ensureTree('child');
    await activateProject('B'); await activateProject('A');
    finish([{ key: 'old.md', path: 'old.md', name: 'old.md' }]); await stale;
    expect(useStore.getState().docs.child).toBeUndefined();
  });
  it('late project activation does not replace the selected project', async () => {
    let finish!: (snapshot: Snapshot) => void;
    mocks.activate.mockImplementation((id: string) => id === 'A' ? new Promise<Snapshot>(resolve => { finish = resolve; }) : Promise.resolve(snapshot(id)));
    const old = activateProject('A'); await activateProject('B'); finish(snapshot('A')); await old;
    expect(useStore.getState().projectId).toBe('B'); expect(useStore.getState().index?.projectId).toBe('B');
  });
});

function entry(key: string): DocEntry { return { key, path: key, name: key }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
let emit!: (event: Invalidated) => void;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });
async function live(projectId: string) {
  mocks.subscribe.mockImplementation(async (listener: typeof emit) => { emit = listener; return () => {}; });
  mocks.bootstrap.mockResolvedValue({ projects: [{ id: projectId, name: projectId, path: projectId }], autoBenchmark: false, autoBenchmarkRepeats: 1, autoBenchmarkSeconds: 60 });
  cleanup = await initialize(); await settle();
}
function invalidate(projectId: string, revision: number, options: Partial<Changes> = {}) {
  mocks.changes.mockResolvedValueOnce({ projectId, epoch: 'session', baseRevision: revision - 1, revision, resetRequired: false, upserts: [], removed: [], rootKeys: null, documentTaskKeys: ['parent'], diagnostics: [], ...options });
  emit({ projectId, epoch: 'session', revision });
}

describe('stable workspace selection and refresh', () => {
  it('makes same loaded-project and document clicks idempotent without clearing committed state', async () => {
    mocks.tree.mockResolvedValue([entry('prd.md')]);
    await activateProject('idempotent'); await settle();
    const before = useStore.getState();
    const observe = vi.fn(); const unsubscribe = useStore.subscribe(observe);
    await activateProject('idempotent'); selectDocument('parent', 'prd.md');
    expect(useStore.getState()).toBe(before);
    expect(observe).not.toHaveBeenCalled();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.tree).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it('allows retrying a failed activation with no index', async () => {
    mocks.activate.mockRejectedValueOnce(new Error('offline'));
    await activateProject('retry-project');
    expect(useStore.getState().index).toBeNull();
    await activateProject('retry-project');
    expect(useStore.getState().index?.projectId).toBe('retry-project');
    expect(mocks.activate).toHaveBeenCalledTimes(2);
  });
  it('allows same-project reactivation to recover a background index error', async () => {
    await activateProject('retry-background'); await settle();
    useStore.setState({ error: 'background read failed' });
    await activateProject('retry-background');
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(useStore.getState().error).toBe('');
  });
  it('keeps selection during a root tree read then publishes the next document once, including a truly empty root', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]);
    await activateProject('root-transition'); await settle();
    const previous = useStore.getState().selectedDoc;
    const next = deferred<DocEntry[]>(); mocks.tree.mockReturnValueOnce(next.promise);
    selectRoot('child');
    expect(useStore.getState()).toMatchObject({ rootKey: 'child', pendingRootKey: 'child', selectedDoc: previous });
    next.resolve([entry('next.md')]); await settle();
    expect(useStore.getState()).toMatchObject({ pendingRootKey: null, selectedDoc: { taskKey: 'child', key: 'next.md' } });
    useStore.setState({ docs: { ...useStore.getState().docs, parent: [] } });
    selectRoot('parent'); await settle();
    expect(useStore.getState()).toMatchObject({ selectedDoc: null, pendingRootKey: null });
  });
  it('does not overwrite a user document click with an earlier automatic root selection', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]);
    await activateProject('root-user-choice'); await settle();
    const next = deferred<DocEntry[]>(); mocks.tree.mockReturnValueOnce(next.promise);
    selectRoot('child'); selectDocument('child', 'chosen.md');
    next.resolve([entry('first.md'), entry('chosen.md')]); await settle();
    expect(useStore.getState().selectedDoc).toEqual({ taskKey: 'child', key: 'chosen.md' });
  });
  it('keeps an invalidated tree and selection visible until fresh data arrives', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]); await live('preserved-tree');
    const previous = useStore.getState(); const next = deferred<DocEntry[]>(); mocks.tree.mockReturnValueOnce(next.promise);
    const frames: (DocEntry[] | undefined)[] = [];
    const unsubscribe = useStore.subscribe(state => frames.push(state.docs.parent));
    invalidate('preserved-tree', 2); await settle();
    expect(useStore.getState().docs.parent).toBe(previous.docs.parent);
    expect(useStore.getState().documentVersions.parent).toBe(1);
    expect(useStore.getState().treeVersions.parent.version).toBe(0);
    next.resolve([entry('old.md'), entry('new.md')]); await settle();
    expect(useStore.getState().selectedDoc).toBe(previous.selectedDoc);
    expect(useStore.getState().treeVersions.parent.version).toBe(1);
    expect(frames.every(frame => !!frame)).toBe(true);
    unsubscribe();
  });
  it('retains a failed refreshed tree and its stale marker so retry really reads again', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]); await live('failed-tree');
    const previous = useStore.getState().docs.parent;
    mocks.tree.mockRejectedValueOnce(new Error('tree unavailable'));
    invalidate('failed-tree', 2); await settle();
    expect(useStore.getState().docs.parent).toBe(previous);
    expect(useStore.getState().error).toContain('tree unavailable');
    expect(useStore.getState().treeVersions.parent.version).toBe(0);
    mocks.tree.mockResolvedValueOnce([entry('recovered.md')]); await ensureTree('parent');
    expect(useStore.getState().docs.parent).toEqual([entry('recovered.md')]);
    expect(mocks.tree).toHaveBeenCalledTimes(3);
  });
  it('discards stale tree success and failure when more invalidations arrive during refresh', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]); await live('tree-generations');
    const stale = deferred<DocEntry[]>(); const staleFailure = deferred<DocEntry[]>(); const latest = deferred<DocEntry[]>();
    mocks.tree.mockReturnValueOnce(stale.promise).mockReturnValueOnce(staleFailure.promise).mockReturnValueOnce(latest.promise);
    invalidate('tree-generations', 2); await settle();
    invalidate('tree-generations', 3); await settle();
    invalidate('tree-generations', 4); await settle();
    stale.resolve([entry('obsolete.md')]); staleFailure.reject(new Error('obsolete failure')); await settle();
    expect(useStore.getState().docs.parent).toEqual([entry('old.md')]);
    expect(useStore.getState().error).toBe('');
    latest.resolve([entry('latest.md')]); await settle();
    expect(useStore.getState().docs.parent).toEqual([entry('latest.md')]);
    expect(useStore.getState().treeVersions.parent.version).toBe(3);
  });
  it('keeps cached trees across snapshot recovery and forces their reset generation to reread', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]); await live('snapshot-preservation');
    const before = useStore.getState(); const next = deferred<DocEntry[]>(); mocks.tree.mockReturnValueOnce(next.promise);
    mocks.snapshot.mockResolvedValueOnce({ ...snapshot('snapshot-preservation'), revision: 2 });
    invalidate('snapshot-preservation', 2, { resetRequired: true }); await settle();
    expect(useStore.getState().docs.parent).toBe(before.docs.parent);
    expect(useStore.getState().documentReset).toBe(before.documentReset + 1);
    expect(mocks.tree).toHaveBeenCalledTimes(2);
    next.resolve([entry('new.md')]); await settle();
    expect(useStore.getState().treeVersions.parent.reset).toBe(useStore.getState().documentReset);
    expect(useStore.getState().docs.parent).toEqual([entry('new.md')]);
  });
  it('ends a failed root transition without silently selecting another document', async () => {
    mocks.tree.mockResolvedValue([entry('old.md')]); await activateProject('failed-root'); await settle();
    const previous = useStore.getState().selectedDoc;
    mocks.tree.mockRejectedValueOnce(new Error('root unavailable'));
    selectRoot('child'); await settle();
    expect(useStore.getState().pendingRootKey).toBeNull();
    expect(useStore.getState().selectedDoc).toBe(previous);
    expect(useStore.getState().error).toContain('root unavailable');
    mocks.tree.mockResolvedValueOnce([entry('retried.md')]);
    selectRoot('child'); await settle();
    expect(useStore.getState().selectedDoc).toEqual({ taskKey: 'child', key: 'retried.md' });
    expect(useStore.getState().pendingRootKey).toBeNull();
    expect(useStore.getState().error).toBe('');
  });
});

it('shares an in-flight same-project activation but starts a new generation for A → B → A', async () => {
  const oldA = deferred<Snapshot>(); const newA = deferred<Snapshot>();
  mocks.activate.mockReturnValueOnce(oldA.promise).mockResolvedValueOnce(snapshot('pending-B')).mockReturnValueOnce(newA.promise);
  const first = activateProject('pending-A'); const repeated = activateProject('pending-A');
  expect(mocks.activate).toHaveBeenCalledTimes(1);
  await activateProject('pending-B');
  const latest = activateProject('pending-A');
  expect(mocks.activate).toHaveBeenCalledTimes(3);
  newA.resolve({ ...snapshot('pending-A'), revision: 3 }); await latest;
  oldA.resolve({ ...snapshot('pending-A'), revision: 1 }); await Promise.all([first, repeated]);
  expect(useStore.getState().index?.revision).toBe(3);
});
it('ignores an old tree failure after its task is removed in the same project', async () => {
  mocks.tree.mockResolvedValue([entry('old.md')]); await live('removed-tree');
  const old = deferred<DocEntry[]>(); mocks.tree.mockReturnValueOnce(old.promise);
  const reading = ensureTree('child');
  invalidate('removed-tree', 2, { removed: ['child'], documentTaskKeys: [] }); await settle();
  old.reject(new Error('deleted task tree')); await reading;
  expect(useStore.getState().error).toBe('');
});

it('supports root and folder collapse while child expansion loads documents', async () => {
  mocks.tree.mockResolvedValue([entry('prd.md')]);
  await activateProject('tree-sections'); await settle();
  const before = useStore.getState();
  toggleExpanded('task:parent');
  expect(useStore.getState().expanded.has('collapsed-task:parent')).toBe(true);
  toggleExpanded('task:parent');
  toggleExpanded('folder:parent:research');
  expect(useStore.getState().expanded.has('folder:parent:research')).toBe(true);
  toggleExpanded('collapsed-children:parent');
  expect(useStore.getState().selectedDoc).toBe(before.selectedDoc);
  toggleExpanded('task:child', 'child'); await settle();
  expect(mocks.tree).toHaveBeenLastCalledWith('tree-sections', 'child');
  selectDocument('child', 'prd.md');
  expect(useStore.getState().expanded.has('collapsed-children:parent')).toBe(false);
  expect(useStore.getState().expanded.has('task:child')).toBe(true);
});

it('removing an inactive project preserves the current reader', async () => {
  await activateProject('keep'); await settle();
  const before = useStore.getState();
  mocks.removeProject.mockResolvedValue([{ id: 'keep', name: 'Keep', path: '/keep' }]);
  await removeProject('other');
  expect(useStore.getState().index).toBe(before.index);
  expect(useStore.getState().projectId).toBe('keep');
});
it('removing the last project clears selection and rejects pending activation', async () => {
  const pending = deferred<Snapshot>(); mocks.activate.mockReturnValueOnce(pending.promise);
  const opening = activateProject('removed');
  mocks.removeProject.mockResolvedValue([]);
  await removeProject('removed'); pending.resolve(snapshot('removed')); await opening;
  expect(useStore.getState()).toMatchObject({ projectId: '', index: null, selectedDoc: null, loading: false });
});
it('selecting the same document reveals its collapsed folder and root', async () => {
  mocks.tree.mockResolvedValue([{ key: 'research/a.md', path: 'research/a.md', name: 'a.md' }]);
  await activateProject('reveal'); await settle();
  selectDocument('parent', 'research/a.md');
  toggleExpanded('task:parent'); toggleExpanded('folder:parent:research');
  selectDocument('parent', 'research/a.md');
  expect(useStore.getState().expanded.has('collapsed-task:parent')).toBe(false);
  expect(useStore.getState().expanded.has('folder:parent:research')).toBe(true);
});

describe('project removal', () => {
  const project = (id: string) => ({ id, name: id, path: `/${id}` });
  it('preserves selection on failure and when another project is removed', async () => {
    useStore.setState({ projects: [project('remove-other'), project('keep-current')] });
    await activateProject('keep-current');
    mocks.removeProject.mockRejectedValueOnce(new Error('disk full'));
    await expect(removeProject('remove-other')).rejects.toThrow('disk full');
    expect(useStore.getState().projects).toHaveLength(2);
    mocks.removeProject.mockResolvedValueOnce([project('keep-current')]);
    await removeProject('remove-other');
    expect(useStore.getState().projectId).toBe('keep-current');
    expect(useStore.getState().projects.map(p => p.id)).toEqual(['keep-current']);
  });
  it('switches to the first remaining project, then clears the last project', async () => {
    useStore.setState({ projects: [project('first-remaining'), project('remove-current')] });
    await activateProject('remove-current');
    mocks.removeProject.mockResolvedValueOnce([project('first-remaining')]).mockResolvedValueOnce([]);
    await removeProject('remove-current');
    expect(useStore.getState().projectId).toBe('first-remaining');
    await removeProject('first-remaining');
    expect(useStore.getState()).toMatchObject({ projectId: '', index: null, selectedDoc: null, projects: [], loading: false });
  });
  it('discards late activation after removal and permits restored identity', async () => {
    const pending = deferred<Snapshot>();
    useStore.setState({ projects: [project('restore-id')] });
    mocks.activate.mockReturnValueOnce(pending.promise);
    const activating = activateProject('restore-id');
    mocks.removeProject.mockResolvedValue([]);
    await removeProject('restore-id');
    pending.resolve(snapshot('restore-id')); await activating;
    expect(useStore.getState().index).toBeNull();
    mocks.addProject.mockResolvedValue(project('restore-id'));
    await addProject();
    expect(useStore.getState().index?.projectId).toBe('restore-id');
  });
  it('respects a selection changed while removal is waiting for persistence', async () => {
    useStore.setState({ projects: [project('waiting-remove'), project('chosen-during-save'), project('third')] });
    await activateProject('waiting-remove');
    const pending = deferred<ReturnType<typeof project>[]>();
    mocks.removeProject.mockReturnValueOnce(pending.promise);
    const removing = removeProject('waiting-remove');
    await activateProject('chosen-during-save');
    pending.resolve([project('chosen-during-save'), project('third')]); await removing;
    expect(useStore.getState().projectId).toBe('chosen-during-save');
  });
});
