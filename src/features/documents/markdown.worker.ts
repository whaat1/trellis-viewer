import { parseMarkdown } from './markdown';
self.onmessage = (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  try {
    const parsed = parseMarkdown(source);
    // Transfer compact strings, not tens of thousands of HAST objects. The
    // main thread decodes only visible blocks and never clones the full tree.
    const blocks = parsed.blocks.map(({ key, nodeJson, anchor, estimate }) => ({ key, nodeJson, anchor, estimate }));
    self.postMessage({ id, result: { ...parsed, blocks } });
  }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Markdown 解析失败' }); }
};
