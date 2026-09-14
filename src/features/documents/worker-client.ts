import type { MarkdownPayload } from './markdown';
import { metrics } from '../../bridge/api';
let worker: Worker | undefined;
let pending: { id: number; resolve: (value: MarkdownPayload) => void; reject: (error: Error) => void } | undefined;
let sequence = 0;
export function cancelParse() {
  if (!pending) return;
  pending.reject(new Error('Superseded')); pending = undefined;
  worker?.terminate(); worker = undefined;
}
export function parseInWorker(source: string): Promise<MarkdownPayload> {
  cancelParse();
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; result?: MarkdownPayload; error?: string }>) => {
      if (!pending || event.data.id !== pending.id) return;
      const active = pending; pending = undefined;
      if (event.data.result) active.resolve(event.data.result); else active.reject(new Error(event.data.error));
    };
    worker.onerror = event => { pending?.reject(new Error(event.message || 'Markdown Worker 无法启动')); pending = undefined; worker?.terminate(); worker = undefined; };
  }
  metrics.markdownParses++;
  return new Promise((resolve, reject) => { const id = ++sequence; pending = { id, resolve, reject }; worker!.postMessage({ id, source }); });
}
