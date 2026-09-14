import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import type { MarkdownPayload } from './markdown';
import type { Element, RootContent } from 'hast';

const exec = promisify(execFile);
const jsc = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
const corpus = [
  { name: 'baseline-64k.md', deadlineMs: 500 },
  { name: 'long-paragraphs.md', deadlineMs: 1000 },
  { name: 'long-table.md', deadlineMs: 2000 },
  { name: 'long-code.md', deadlineMs: 1000 },
  { name: 'images.md', deadlineMs: 500 },
] as const;
let output = '';
let workerPath = '';
let workerSource = '';
const sources = new Map<string, string>();
interface WorkerMessage { result?: MarkdownPayload; error?: string }

beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), 'trellis-worker-test-'));
  // Use the same owned-fixture generator as native benchmarks, not a smaller
  // hand-picked Markdown approximation that can miss engine-specific regressions.
  await exec('python3', ['scripts/fixtures.py', 'generate', '--out', join(output, 'fixture'), '--count', '5']);
  for (const item of corpus) sources.set(item.name, await readFile(join(output, 'fixture/.trellis/tasks/09-11-task-00000', item.name), 'utf8'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'silent', build: { outDir: join(output, 'build'), emptyOutDir: true, sourcemap: false } });
  const file = (await readdir(join(output, 'build/assets'))).find(name => name.startsWith('markdown.worker-') && name.endsWith('.js'));
  expect(file).toBeDefined();
  workerPath = join(output, 'build/assets', file!);
  workerSource = await readFile(workerPath, 'utf8');
}, 30000);
afterAll(async () => { if (output) await rm(output, { recursive: true, force: true }); });

async function parseNode(source: string, deadlineMs: number): Promise<MarkdownPayload> {
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); globalThis.self = { postMessage: value => parentPort.postMessage(value) }; parentPort.on('message', data => self.onmessage({ data })); ${workerSource}`, { eval: true });
  try {
    const message = await new Promise<WorkerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Production Worker exceeded ${deadlineMs}ms`)), deadlineMs);
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.once('message', value => { clearTimeout(timeout); resolve(value); });
      worker.postMessage({ id: 1, source });
    });
    expect(message.error).toBeUndefined();
    expect(message.result).toBeDefined();
    return message.result!;
  } finally { await worker.terminate(); }
}

async function parseJavaScriptCore(name: string, deadlineMs: number): Promise<MarkdownPayload> {
  const script = join(output, `jsc-${name}.js`);
  await writeFile(script, `
    globalThis.self = globalThis;
    globalThis.TextEncoder = class { encode(value) {
      const bytes = unescape(encodeURIComponent(value));
      return Uint8Array.from(bytes, char => char.charCodeAt(0));
    }};
    self.postMessage = message => print(JSON.stringify(message));
    load(${JSON.stringify(workerPath)});
    const source = readFile(${JSON.stringify(join(output, 'fixture/.trellis/tasks/09-11-task-00000', name))});
    self.onmessage({ data: { id: 1, source } });
  `);
  // Process deadline includes startup and output serialization; parseMs below
  // measures the parser itself. Neither is WKWebView layout/input latency.
  const { stdout } = await exec(jsc, [script], { timeout: deadlineMs + 1000, maxBuffer: 64 * 1024 * 1024 });
  const message: WorkerMessage = JSON.parse(stdout.trim());
  expect(message.error).toBeUndefined();
  expect(message.result).toBeDefined();
  return message.result!;
}

function elements(node: RootContent, tag: string): Element[] {
  return [...(node.type === 'element' && node.tagName === tag ? [node] : []), ...('children' in node ? node.children.flatMap(child => elements(child as RootContent, tag)) : [])];
}
function text(node: RootContent): string {
  return node.type === 'text' ? node.value : 'children' in node ? node.children.map(child => text(child as RootContent)).join('') : '';
}
function verifyCorpus(name: string, result: MarkdownPayload) {
  const source = sources.get(name)!;
  expect(result.sourceBytes).toBe(Buffer.byteLength(source));
  const nodes = result.blocks.map(block => JSON.parse(block.nodeJson) as RootContent);
  expect(result.blocks.every(block => !('node' in block))).toBe(true);
  if (name === 'baseline-64k.md') {
    expect(result.sourceBytes).toBe(65536);
    expect(nodes.map(text)).toEqual(source.trimEnd().split(/\n\n+/).map(part => part.replace(/^# /, '')));
  } else if (name === 'long-paragraphs.md') {
    expect(nodes.flatMap(node => elements(node, 'h2')).map(text)).toEqual(Array.from({ length: 1100 }, (_, i) => `第 ${i} 节`));
    const paragraphs = nodes.flatMap(node => elements(node, 'p')).map(text);
    expect(paragraphs).toHaveLength(1100);
    expect(paragraphs.every(value => value === '任务数据在后台更新，阅读位置应保持稳定。'.repeat(20))).toBe(true);
  } else if (name === 'long-table.md') {
    const bodies = nodes.flatMap(node => elements(node, 'tbody'));
    const numbers = bodies.flatMap(body => elements(body, 'tr')).map(row => text(elements(row, 'td')[0]));
    expect(numbers).toEqual(Array.from({ length: 16000 }, (_, i) => String(i)));
    expect(bodies.length).toBeGreaterThan(1);
  } else if (name === 'long-code.md') {
    const code = nodes.flatMap(node => elements(node, 'code'));
    const expected = Array.from({ length: 26000 }, (_, i) => `${String(i).padStart(6, '0')} 任务索引与只读读取的测试行。\n`).join('');
    expect(code.map(text).join('\n')).toBe(expected);
    expect(code.length).toBeGreaterThan(1);
  } else {
    const images = nodes.flatMap(node => elements(node, 'img'));
    expect(images.map(image => image.properties.alt)).toEqual(Array.from({ length: 30 }, (_, i) => `本地示例 ${i}`));
    expect(images.every(image => image.properties.src === 'image.png')).toBe(true);
  }
}

it('production Worker executes GFM/entities without a document global', async () => {
  const result = await parseNode('# Worker &amp; GFM\n\n- [x] ready\n\n| A | B |\n|---|---|\n| 1 | 2 |', 3000);
  expect(result.blocks.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(result.blocks)).toContain('Worker & GFM');
  expect(JSON.stringify(result.blocks)).toContain('checkbox');
});
describe('full production Worker corpus (V8)', () => {
  for (const item of corpus) it(`${item.name} preserves content within its regression deadline`, async () => {
    const result = await parseNode(sources.get(item.name)!, item.deadlineMs);
    expect(result.parseMs).toBeLessThan(item.deadlineMs);
    verifyCorpus(item.name, result);
    console.info(`V8 ${item.name}: parser ${result.parseMs.toFixed(1)}ms`);
  }, item.deadlineMs + 3000);
});
describe.skipIf(!existsSync(jsc))('full production Worker corpus (system JavaScriptCore)', () => {
  for (const item of corpus) it(`${item.name} preserves content within its regression deadline`, async () => {
    const result = await parseJavaScriptCore(item.name, item.deadlineMs);
    expect(result.parseMs).toBeLessThan(item.deadlineMs);
    verifyCorpus(item.name, result);
    console.info(`JavaScriptCore ${item.name}: parser ${result.parseMs.toFixed(1)}ms (CLI, no layout/IPC)`);
  }, item.deadlineMs + 3000);
});
