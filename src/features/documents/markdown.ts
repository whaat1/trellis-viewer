import { unified } from 'unified';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { parseFragment } from 'parse5';
import { fromParse5 } from 'hast-util-from-parse5';
import rehypeSanitize from 'rehype-sanitize';
import type { Root, RootContent, Element } from 'hast';
export interface SerializedMarkdownBlock { key: string; nodeJson: string; anchor: string | null; estimate: number }
export interface MarkdownBlock extends SerializedMarkdownBlock { node: RootContent }
export interface MarkdownPayload { blocks: SerializedMarkdownBlock[]; parseMs: number; sourceBytes: number; stageMs: { markdown: number; html: number; sanitize: number; blocks: number } }
export interface ParsedMarkdown extends MarkdownPayload { blocks: MarkdownBlock[] }
// Parse the complete source before dividing semantic blocks. Source splitting
// would break fenced code, reference links and GFM table cell escapes.
// HTML is an intermediate Worker-only value, parsed without DOM and always
// sanitized. Raw HTML is disabled; task-list inputs remain read-only.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(taskLists, { enabled: false });
markdown.renderer.rules.th_open = markdown.renderer.rules.td_open = (tokens, index, options, _env, renderer) => {
  // Preserve generated table alignment through the sanitizer without allowing
  // arbitrary CSS. This transforms parser tokens, never source Markdown.
  const token = tokens[index];
  const alignment = String(token.attrGet('style') ?? '').match(/^text-align:(left|right|center)$/)?.[1];
  if (alignment) { token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'style'); token.attrSet('align', alignment); }
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.s_open = () => '<del>';
markdown.renderer.rules.s_close = () => '</del>';
const sanitizer = unified().use(rehypeSanitize);
function plain(node: RootContent): string { return node.type === 'text' ? node.value : 'children' in node ? node.children.map(child => plain(child as RootContent)).join('') : ''; }
function hash(value: string) { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }
function divide(node: RootContent): RootContent[] {
  if (node.type !== 'element') return node.type === 'text' && !node.value.trim() ? [] : [node];
  if (node.tagName === 'table') {
    const head = node.children.find(child => child.type === 'element' && child.tagName === 'thead');
    const body = node.children.find(child => child.type === 'element' && child.tagName === 'tbody') as Element | undefined;
    const rows = body?.children.filter(child => child.type === 'element' && child.tagName === 'tr') ?? [];
    if (body && rows.length > 24) {
      const chunks: RootContent[] = [];
      for (let i = 0; i < rows.length; i += 24) chunks.push({ ...node, children: [...(head ? [head] : []), { ...body, children: rows.slice(i, i + 24) }] });
      return chunks;
    }
  }
  if (node.tagName === 'pre') {
    const code = node.children.find(child => child.type === 'element' && child.tagName === 'code') as Element | undefined;
    if (code) {
      const lines = plain(code).split('\n');
      if (lines.length > 80) {
        const chunks: RootContent[] = [];
        for (let i = 0; i < lines.length; i += 80) chunks.push({ ...node, children: [{ ...code, children: [{ type: 'text', value: lines.slice(i, i + 80).join('\n') }] }] });
        return chunks;
      }
    }
  }
  if (node.tagName === 'ul' || node.tagName === 'ol') {
    // HAST inserts whitespace text nodes between list items. Numbering and
    // chunk boundaries must count actual items rather than those separators.
    const items = node.children.filter(child => child.type === 'element' && child.tagName === 'li');
    if (items.length > 30) {
      const chunks: RootContent[] = [];
      for (let i = 0; i < items.length; i += 30) chunks.push({ ...node, properties: { ...node.properties, ...(node.tagName === 'ol' ? { start: Number(node.properties.start ?? 1) + i } : {}) }, children: items.slice(i, i + 30) });
      return chunks;
    }
  }
  return [node];
}
export function parseMarkdown(source: string): ParsedMarkdown {
  const start = performance.now();
  const html = markdown.render(source);
  const afterMarkdown = performance.now();
  // Locations would point into generated HTML, not the original Markdown.
  // Avoid allocating them: they inflated the native table AST to ~29MB and
  // made unchanged block identities depend on preceding text offsets.
  const htmlTree = parseFragment(html, { sourceCodeLocationInfo: false, scriptingEnabled: false });
  const converted = fromParse5(htmlTree);
  if (converted.type !== 'root') throw new Error('Markdown fragment did not produce a document root');
  const afterHtml = performance.now();
  const tree = sanitizer.runSync(converted) as Root;
  const afterSanitize = performance.now();
  const seen = new Map<string, number>();
  const headings = new Map<string, number>();
  const nodes = tree.children.flatMap(divide);
  const blocks = nodes.map(node => {
    const content = plain(node);
    if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
      const slug = content.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const count = headings.get(slug) ?? 0; headings.set(slug, count + 1);
      node.properties.id = count ? `${slug}-${count}` : slug;
    }
    const nodeJson = JSON.stringify(node);
    const identity = hash(nodeJson);
    const count = seen.get(identity) ?? 0; seen.set(identity, count + 1);
    const tag = node.type === 'element' ? node.tagName : '';
    const estimate = tag === 'pre' ? Math.min(1800, content.split('\n').length * 21 + 32) : tag === 'table' ? 500 : /^h/.test(tag) ? 70 : Math.max(48, Math.ceil(content.length / 70) * 26 + 16);
    const anchor = node.type === 'element' && typeof node.properties.id === 'string' ? node.properties.id : null;
    return { key: `${identity}:${count}`, node, nodeJson, anchor, estimate };
  });
  const finished = performance.now();
  return { blocks, parseMs: finished - start, sourceBytes: new TextEncoder().encode(source).byteLength, stageMs: { markdown: afterMarkdown - start, html: afterHtml - afterMarkdown, sanitize: afterSanitize - afterHtml, blocks: finished - afterSanitize } };
}
