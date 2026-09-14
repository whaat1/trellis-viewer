import type { Document } from '../../generated/contracts';
import type { MarkdownPayload } from './markdown';

export interface ReaderTarget { projectId: string; taskKey: string; key: string }
export function readerIdentity(target: ReaderTarget): string { return `${target.projectId}:${target.taskKey}:${target.key}`; }
interface ReaderDependencies {
  read: (target: ReaderTarget) => Promise<Document>;
  parse: (source: string) => Promise<MarkdownPayload>;
  cancelParse: () => void;
  committed: () => { identity: string; revision: string } | null;
  onBusy: (busy: boolean) => void;
  onError: (error: unknown, target: ReaderTarget) => void;
  onCommit: (target: ReaderTarget, document: Document, parsed: MarkdownPayload) => void;
  onRead: (document: Document) => void;
  onReady: (target: ReaderTarget, isCurrent: () => boolean) => Promise<void>;
  onStale: () => void;
}
interface Session { target: ReaderTarget; identity: string; requested: number; running: boolean }
/** One read/parse in flight per selection. Refresh signals coalesce, and only
 * a response that still matches the selection and refresh generation commits. */
export function createReaderController(deps: ReaderDependencies) {
  let session: Session | null = null;
  async function run(active: Session) {
    if (active.running) return;
    active.running = true;
    deps.onBusy(true);
    while (session === active) {
      const version = active.requested;
      const isCurrent = () => session === active && active.requested === version;
      try {
        const document = await deps.read(active.target);
        if (!isCurrent()) { deps.onStale(); if (session === active) continue; break; }
        const committed = deps.committed();
        if (committed?.identity !== active.identity || committed.revision !== document.revision) {
          const parsed = await deps.parse(document.content);
          if (!isCurrent()) { deps.onStale(); if (session === active) continue; break; }
          deps.onCommit(active.target, document, parsed);
        }
        deps.onRead(document);
        deps.onBusy(false);
        await deps.onReady(active.target, isCurrent);
      } catch (error) {
        if (isCurrent()) { deps.onError(error, active.target); deps.onBusy(false); }
      }
      if (session !== active || active.requested === version) break;
      deps.onBusy(true);
    }
    active.running = false;
  }
  return {
    select(target: ReaderTarget | null) {
      const identity = target ? readerIdentity(target) : '';
      if ((session?.identity ?? '') === identity) return false;
      session = target ? { target, identity, requested: 1, running: false } : null;
      deps.cancelParse();
      if (session) void run(session); else deps.onBusy(false);
      return true;
    },
    refresh() { if (session) { session.requested++; void run(session); } },
    dispose() { session = null; deps.cancelParse(); },
  };
}
