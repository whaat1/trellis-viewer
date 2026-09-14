import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, errorText, metrics } from '../../bridge/api';
import { useStore, selectDocument } from '../../state/store';
import { WorkspaceIcon } from '../../app/WorkspaceIcon';
import { createReaderController, readerIdentity, type ReaderTarget } from './reader-controller';
import { ReaderPositionMemory } from './reader-position';
import './reader.css';
import { parseInWorker, cancelParse } from './worker-client';
import type { SerializedMarkdownBlock, MarkdownPayload } from './markdown';
import type { RootContent } from 'hast';
const positions = new Map<string, number>();
const MarkdownPiece = memo(function MarkdownPiece({ block }: { block: SerializedMarkdownBlock }) {
  const node = useMemo(() => JSON.parse(block.nodeJson) as RootContent, [block.nodeJson]);
  return toJsxRuntime({ type: 'root', children: [node] }, { Fragment, jsx, jsxs, components: { img: ({ alt }) => <span className="image-placeholder" role="img" aria-label={String(alt || '图片')}>▧ {String(alt || '图片')} <small>图片预览将在后续版本提供</small></span> } });
});
interface CommittedDocument { target: ReaderTarget; identity: string; revision: string; parsed: MarkdownPayload }
interface ScrollAnchor { key?: string; index: number; offset: number; top: number }
const noBlocks: SerializedMarkdownBlock[] = [];
export const Reader = memo(function Reader() {
  const projectId = useStore(s => s.projectId);
  const selected = useStore(s => s.selectedDoc);
  const version = useStore(s => s.selectedDoc ? s.documentVersions[s.selectedDoc.taskKey] ?? 0 : 0);
  const reset = useStore(s => s.documentReset);
  const projectLoading = useStore(s => s.loading);
  const pendingRootKey = useStore(s => s.pendingRootKey);
  const taskKey = selected?.taskKey;
  const documentKey = selected?.key;
  const identity = selected ? readerIdentity({ projectId, ...selected }) : '';
  const suspended = projectLoading || !!pendingRootKey;
  const [committed, setCommitted] = useState<CommittedDocument | null>(null);
  const outsideRoot = useStore(state => {
    if (!committed) return false;
    if (committed.target.projectId !== state.projectId) return true;
    let key: string | null = committed.target.taskKey;
    const seen = new Set<string>();
    while (key && !seen.has(key)) {
      if (key === state.rootKey) return false;
      seen.add(key); key = state.index?.tasks[key]?.parentKey ?? null;
    }
    return true;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const committedRef = useRef(committed);
  const positionMemory = useRef(new ReaderPositionMemory(positions));
  const restore = useRef<ScrollAnchor | null>(null);
  const blocks = committed?.parsed.blocks ?? noBlocks;
  const virtual = useVirtualizer({ count: blocks.length, getScrollElement: () => scroll.current, estimateSize: i => blocks[i]?.estimate ?? 80, getItemKey: i => blocks[i]?.key ?? i, overscan: 3 });
  const virtualRef = useRef(virtual); virtualRef.current = virtual;
  const [controller] = useState(() => createReaderController({
    read: target => api.document(target.projectId, target.taskKey, target.key),
    parse: parseInWorker, cancelParse,
    committed: () => committedRef.current,
    onBusy: value => { setBusy(value); if (value) setError(''); },
    onError: (failure, target) => setError(`${committedRef.current?.identity === readerIdentity(target) ? '刷新' : '打开'}“${target.key}”失败：${errorText(failure)}`),
    onCommit: (target, document, parsed) => {
      const nextIdentity = readerIdentity(target);
      const previous = committedRef.current;
      const switching = previous?.identity !== nextIdentity;
      const currentTop = scroll.current?.scrollTop ?? 0;
      const top = positionMemory.current.startCommit(nextIdentity, currentTop);
      const visible = virtualRef.current.getVirtualItems().find(item => item.end > top);
      restore.current = switching ? { index: 0, offset: 0, top } : { key: visible ? previous?.parsed.blocks[visible.index]?.key : undefined, index: visible?.index ?? 0, offset: visible ? top - visible.start : 0, top };
      // Until layout installs the new content and its scroll target, a scroll
      // event still belongs to the document currently on screen.
      const next = { target, identity: nextIdentity, revision: document.revision, parsed };
      committedRef.current = next;
      setCommitted(next);
      if (switching) setNotice('');
      metrics.lastDocumentParseMs = parsed.parseMs;
      metrics.lastDocumentSourceBytes = parsed.sourceBytes;
      metrics.markdownCommits++;
    },
    onRead: document => { metrics.lastDocumentReadMs = document.readMs; },
    onReady: (target, isCurrent) => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isCurrent() && positionMemory.current.identity === readerIdentity(target)) { metrics.documentReadyCount++; metrics.documentReadyIdentity = readerIdentity(target); }
      resolve();
    }))),
    onStale: () => { metrics.staleResponses++; },
  }));
  useEffect(() => {
    if (suspended) { controller.select(null); setError(''); return; }
    if (taskKey && documentKey) {
      if (!controller.select({ projectId, taskKey, key: documentKey })) controller.refresh();
    } else {
      controller.select(null);
      positionMemory.current.clear(scroll.current?.scrollTop ?? 0);
      committedRef.current = null; restore.current = null;
      setCommitted(null); setBusy(false); setError(''); setNotice('');
    }
  }, [controller, projectId, taskKey, documentKey, suspended, version, reset]);
  useEffect(() => () => controller.dispose(), [controller]);
  useLayoutEffect(() => {
    const target = restore.current;
    if (!target || !committed || !scroll.current) return;
    restore.current = null;
    if (target.key) {
      const found = committed.parsed.blocks.findIndex(block => block.key === target.key);
      const index = found >= 0 ? found : Math.min(target.index, committed.parsed.blocks.length - 1);
      if (index >= 0) virtual.scrollToIndex(index, { align: 'start' });
      const top = virtual.getOffsetForIndex(Math.max(0, index), 'start')?.[0];
      if (top !== undefined) virtual.scrollToOffset(top + target.offset);
    } else virtual.scrollToOffset(target.top);
    positionMemory.current.finishCommit(committed.identity);
  }, [committed, virtual]);
  function onLink(event: MouseEvent<HTMLDivElement>) {
    const element = (event.target as HTMLElement).closest('a');
    if (!element) return;
    event.preventDefault();
    const href = element.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      let anchor = href.slice(1); try { anchor = decodeURIComponent(anchor); } catch { /* Keep literal malformed anchors. */ }
      const index = blocks.findIndex(block => block.anchor === anchor);
      if (index >= 0) virtual.scrollToIndex(index, { align: 'start' });
      return;
    }
    const displayed = committed?.target;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && displayed && displayed.projectId === projectId && !suspended) {
      const base = displayed.key.split('/').slice(0, -1);
      for (const segment of href.split('#')[0].split('/')) { if (segment === '..') base.pop(); else if (segment !== '.') base.push(segment); }
      const doc = useStore.getState().docs[displayed.taskKey]?.find(entry => entry.path === base.join('/'));
      if (doc) { selectDocument(displayed.taskKey, doc.key); return; }
    }
    setNotice(suspended ? '正在切换任务，请稍候。' : '暂不支持打开此链接。');
  }
  const displayedKey = committed?.target.key ?? documentKey;
  const switching = !!committed && committed.identity !== identity;
  const status = projectLoading ? '正在切换项目…' : pendingRootKey ? '正在切换任务…' : busy ? switching ? `正在打开 ${documentKey?.split('/').pop() ?? '文档'}…` : committed ? '正在更新…' : '读取中…' : switching || outsideRoot ? '保留上一份文档' : '';
  return <section className="reader pane" aria-label="文档内容">
    <header className="pane-header"><span className="file-icon"><WorkspaceIcon name="file" size={16}/></span><strong title={displayedKey}>{displayedKey?.split('/').pop() ?? '文档阅读'}</strong><span className="spacer"/><span className="subtle reader-status" role="status" title={status}>{status}</span></header>
    <div className="reader-body">
      {(notice || error) && <div className="reader-messages">{notice && <div className="notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}{error && <div className="error" role="alert"><span>{error}</span><button disabled={suspended || busy} onClick={() => controller.refresh()}>重试</button></div>}</div>}
      <div ref={scroll} className="document-scroll" data-perf-scroll="document" data-document-identity={committed?.identity} data-document-revision={committed?.revision} onClick={onLink} onScroll={() => { if (scroll.current) positionMemory.current.record(scroll.current.scrollTop); }}>
        {committed ? <div className="markdown" style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map(item => <div key={item.key} ref={virtual.measureElement} data-index={item.index} data-block-key={blocks[item.index].key} className="markdown-block" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}><MarkdownPiece block={blocks[item.index]} /></div>)}
        </div> : !selected && !suspended ? <div className="empty"><div className="empty-glyph"><WorkspaceIcon name="file" size={38}/></div><h2>留一点空间，专注阅读</h2><p>从左侧任务目录选择一份 Markdown 文档</p></div> : <div className="empty"><p>{busy || suspended ? '正在准备文档…' : '文档暂不可用'}</p></div>}
      </div>
    </div>
  </section>;
});
