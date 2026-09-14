import { describe, expect, it, vi } from 'vitest';
import type { Document } from '../../generated/contracts';
import type { MarkdownPayload } from './markdown';
import { createReaderController, readerIdentity, type ReaderTarget } from './reader-controller';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const target = (key: string): ReaderTarget => ({ projectId: 'p', taskKey: 'task', key });
const doc = (key: string, revision = '1'): Document => ({ taskKey: 'task', key, revision, content: `${key}:${revision}`, readMs: 3 });
const payload: MarkdownPayload = { blocks: [], sourceBytes: 1, parseMs: 1, stageMs: { markdown: 0, html: 0, sanitize: 0, blocks: 0 } };
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function harness() {
  let committed: { identity: string; revision: string; parsed: MarkdownPayload } | null = null;
  const deps = {
    read: vi.fn(async (value: ReaderTarget) => doc(value.key)), parse: vi.fn(async () => payload), cancelParse: vi.fn(),
    committed: () => committed,
    onBusy: vi.fn(), onError: vi.fn(), onRead: vi.fn(), onStale: vi.fn(), onReady: vi.fn(async () => {}),
    onCommit: vi.fn((value: ReaderTarget, document: Document, parsed: MarkdownPayload) => { committed = { identity: readerIdentity(value), revision: document.revision, parsed }; }),
  };
  return { controller: createReaderController(deps), deps, committed: () => committed };
}
describe('reader commit coordination', () => {
  it('does not reload a repeated selection or replace unchanged refreshed content', async () => {
    const { controller, deps, committed } = harness();
    controller.select(target('A')); await settle();
    const original = committed();
    expect(controller.select(target('A'))).toBe(false);
    expect(deps.read).toHaveBeenCalledTimes(1);
    controller.refresh(); await settle();
    expect(deps.read).toHaveBeenCalledTimes(2);
    expect(deps.parse).toHaveBeenCalledTimes(1);
    expect(committed()).toBe(original);
  });
  it('retains the committed document throughout the next read and parse, then swaps once', async () => {
    const { controller, deps, committed } = harness();
    controller.select(target('A')); await settle();
    const original = committed();
    const reading = deferred<Document>(); const parsing = deferred<MarkdownPayload>();
    deps.read.mockReturnValueOnce(reading.promise); deps.parse.mockReturnValueOnce(parsing.promise);
    controller.select(target('B'));
    expect(committed()).toBe(original);
    reading.resolve(doc('B')); await settle();
    expect(committed()).toBe(original);
    parsing.resolve({ ...payload, sourceBytes: 2 }); await settle();
    expect(committed()?.identity).toBe('p:task:B');
    expect(deps.onCommit).toHaveBeenCalledTimes(2);
  });
  it('preserves committed content on read or parse failure and can retry', async () => {
    const { controller, deps, committed } = harness();
    controller.select(target('A')); await settle(); const original = committed();
    deps.read.mockRejectedValueOnce(new Error('read failed'));
    controller.select(target('B')); await settle();
    expect(committed()).toBe(original);
    expect(deps.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'read failed' }), target('B'));
    deps.parse.mockRejectedValueOnce(new Error('parse failed'));
    controller.refresh(); await settle();
    expect(committed()).toBe(original);
    controller.refresh(); await settle();
    expect(committed()?.identity).toBe('p:task:B');
  });
  it('isolates A → B → A and cancels the obsolete worker without replacing the preserved A', async () => {
    const { controller, deps, committed } = harness();
    controller.select(target('A')); await settle(); const original = committed();
    const obsolete = deferred<MarkdownPayload>(); deps.parse.mockReturnValueOnce(obsolete.promise);
    controller.select(target('B')); await settle();
    controller.select(target('A')); await settle();
    obsolete.resolve({ ...payload, sourceBytes: 9 }); await settle();
    expect(committed()).toBe(original);
    expect(deps.onCommit).toHaveBeenCalledTimes(1);
    expect(deps.cancelParse).toHaveBeenCalledTimes(3);
    expect(deps.onStale).toHaveBeenCalledTimes(1);
  });
  it('coalesces repeated invalidations during reads and parsing and commits only the latest generation', async () => {
    const { controller, deps, committed } = harness();
    controller.select(target('A')); await settle();
    const first = deferred<Document>(); const second = deferred<Document>(); const obsoleteParse = deferred<MarkdownPayload>();
    deps.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(doc('A', '4'));
    deps.parse.mockReturnValueOnce(obsoleteParse.promise);
    controller.refresh(); controller.refresh(); controller.refresh();
    first.resolve(doc('A', '2')); await settle();
    expect(deps.parse).toHaveBeenCalledTimes(1);
    second.resolve(doc('A', '3')); await settle();
    controller.refresh(); controller.refresh(); obsoleteParse.resolve(payload); await settle();
    expect(deps.read).toHaveBeenCalledTimes(4);
    expect(committed()?.revision).toBe('4');
    expect(deps.onCommit).toHaveBeenCalledTimes(2);
  });
  it('does not report an obsolete painted-ready frame or a late failure after suspension', async () => {
    const { controller, deps, committed } = harness();
    const painted = deferred<void>(); let current!: () => boolean;
    deps.onReady.mockImplementationOnce(async (_target?: ReaderTarget, isCurrent?: () => boolean) => { current = isCurrent!; await painted.promise; });
    controller.select(target('A')); await settle();
    controller.select(null);
    expect(current()).toBe(false);
    painted.resolve(); await settle();
    const failing = deferred<Document>(); deps.read.mockReturnValueOnce(failing.promise);
    controller.select(target('B')); controller.dispose(); failing.reject(new Error('late')); await settle();
    expect(deps.onError).not.toHaveBeenCalled();
    expect(committed()?.identity).toBe('p:task:A');
  });
});
