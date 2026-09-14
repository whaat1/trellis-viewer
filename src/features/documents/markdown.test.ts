import { describe, expect, it } from 'vitest';
import type { Element, RootContent } from 'hast';
import { parseMarkdown } from './markdown';

function elements(node: RootContent, tag: string): Element[] {
  return [...(node.type === 'element' && node.tagName === tag ? [node] : []), ...('children' in node ? node.children.flatMap(child => elements(child as RootContent, tag)) : [])];
}
function text(node: RootContent): string {
  return node.type === 'text' ? node.value : 'children' in node ? node.children.map(child => text(child as RootContent)).join('') : '';
}
describe('Markdown rendering contract', () => {
  it('keeps ordered-list numbering and every item across virtual blocks', () => {
    const parsed = parseMarkdown(Array.from({ length: 75 }, (_, i) => `${i + 7}. Item ${i}`).join('\n'));
    const lists = parsed.blocks.flatMap(block => elements(block.node, 'ol'));
    expect(lists.map(list => list.properties.start)).toEqual([7, 37, 67]);
    expect(lists.flatMap(list => elements(list, 'li')).map(text)).toEqual(Array.from({ length: 75 }, (_, i) => `Item ${i}`));
  });
  it('removes executable HTML and unsafe protocols while keeping readable text', () => {
    const parsed = parseMarkdown('<script>alert(1)</script>\n\n[safe](https://example.com) [unsafe](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>');
    const nodes = parsed.blocks.map(block => block.node);
    expect(nodes.flatMap(node => elements(node, 'script'))).toEqual([]);
    const links = nodes.flatMap(node => elements(node, 'a'));
    expect(links[0].properties.href).toBe('https://example.com');
    expect(links.every(link => !String(link.properties.href ?? '').startsWith('javascript:'))).toBe(true);
    expect(nodes.flatMap(node => elements(node, 'img'))).toEqual([]);
  });
  it('retains every table data row and code line while bounding block size', () => {
    const table = parseMarkdown('| A | B |\n|---|---|\n' + Array.from({ length: 101 }, (_, i) => `| row-${i} | value |`).join('\n'));
    const bodies = table.blocks.flatMap(block => elements(block.node, 'tbody'));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.flatMap(body => elements(body, 'tr')).map(row => elements(row, 'td').map(text).join(''))).toEqual(Array.from({ length: 101 }, (_, i) => `row-${i}value`));
    for (const body of bodies) expect(elements(body, 'tr').length).toBeLessThanOrEqual(24);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i}`);
    const code = parseMarkdown('```text\n' + lines.join('\n') + '\n```');
    const chunks = code.blocks.flatMap(block => elements(block.node, 'code'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(text).join('\n')).toBe(lines.join('\n') + '\n');
  });
  it('preserves full-document reference links, fenced table text, cell escapes and GFM formatting', () => {
    const source = [
      '```markdown', '| code | only |', '| --- | --- |', '| [fenced][target] | \x60value\x60 |', '```', '',
      '| Feature | Value |', '| :--- | ---: |', '| [reference][target] | escaped \\| pipe |',
      '| **strong** and ~~removed~~ | \x60code\x60 |', '', '- [x] Complete', '- [ ] Pending', '',
      '[target]: https://example.com/path "Reference title"',
    ].join('\n');
    const nodes = parseMarkdown(source).blocks.map(block => block.node);
    expect(nodes.flatMap(node => elements(node, 'table'))).toHaveLength(1);
    expect(nodes.flatMap(node => elements(node, 'th')).map(cell => cell.properties.align)).toEqual(['left', 'right']);
    expect(nodes.flatMap(node => elements(node, 'code')).map(text)).toContain('| code | only |\n| --- | --- |\n| [fenced][target] | \x60value\x60 |\n');
    const link = nodes.flatMap(node => elements(node, 'a'))[0];
    expect(link.properties.href).toBe('https://example.com/path');
    expect(link.properties.title).toBe('Reference title');
    expect(nodes.flatMap(node => elements(node, 'td')).map(text)).toContain('escaped | pipe');
    expect(nodes.flatMap(node => elements(node, 'strong')).map(text)).toEqual(['strong']);
    expect(nodes.flatMap(node => elements(node, 'del')).map(text)).toEqual(['removed']);
    expect(nodes.flatMap(node => elements(node, 'input')).map(input => Boolean(input.properties.checked))).toEqual([true, false]);
  });

  it('keeps block anchors stable when text is inserted before unchanged content', () => {
    const original = parseMarkdown('# Target\n\nKeep this paragraph.');
    const changed = parseMarkdown('New opening paragraph.\n\n# Target\n\nKeep this paragraph.');
    expect(changed.blocks.slice(1).map(block => block.key)).toEqual(original.blocks.map(block => block.key));
    expect(original.blocks[0].anchor).toBe('target');
    expect(original.blocks.every(block => !block.nodeJson.includes('"position"'))).toBe(true);
  });

});
