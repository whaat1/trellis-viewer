#!/usr/bin/env python3
"""Profile the production Worker in Apple's JavaScriptCore CLI, without a UI."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--project', type=Path, default=Path('.perf-fixtures/daily'))
    parser.add_argument('--timeout', type=float, default=35)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--document', action='append', default=[])
    args = parser.parse_args()
    worker = args.worker or next(Path('dist/assets').glob('markdown.worker-*.js'))
    documents = args.document or ['baseline-64k.md', 'long-paragraphs.md', 'long-table.md', 'long-code.md', 'images.md']
    reports = []
    for name in documents:
        document = args.project.resolve() / '.trellis/tasks/09-11-task-00000' / name
        program = """
globalThis.self = globalThis;
globalThis.TextEncoder = class {
  encode(value) { const bytes = unescape(encodeURIComponent(value)); return Uint8Array.from(bytes, c => c.charCodeAt(0)); }
};
let started = 0;
self.postMessage = message => {
  const elapsedMs = performance.now() - started;
  if (message.error) { print(JSON.stringify({error: message.error})); return; }
  const {blocks, ...timing} = message.result;
  print(JSON.stringify({...timing, elapsedMs, blockCount: blocks.length,
    serializedUtf16CodeUnits: blocks.reduce((sum, block) => sum + block.nodeJson.length, 0)}));
};
"""
        program += f'load({json.dumps(str(worker.resolve()))});\n'
        program += f'const source = readFile({json.dumps(str(document))});\n'
        program += 'started = performance.now(); self.onmessage({data:{id:1,source}});\n'
        with tempfile.TemporaryDirectory(prefix='trellis-jsc-') as directory:
            script = Path(directory) / 'run.js'
            script.write_text(program)
            try:
                process = subprocess.run([JSC, str(script)], capture_output=True, text=True, timeout=args.timeout, check=True)
                record = json.loads(process.stdout.strip().splitlines()[-1])
            except subprocess.TimeoutExpired:
                record = {'timeoutSeconds': args.timeout}
            except (subprocess.CalledProcessError, json.JSONDecodeError, IndexError) as error:
                record = {'error': str(error), 'stdout': getattr(error, 'stdout', ''), 'stderr': getattr(error, 'stderr', '')}
        record['document'] = name
        reports.append(record)
        print(json.dumps(record, ensure_ascii=False), flush=True)
    result = {'engine': 'system JavaScriptCore CLI', 'worker': str(worker.resolve()), 'documents': reports,
              'limitations': 'No IPC, Worker structured clone, React layout or physical input; TextEncoder is a JS compatibility shim. Use release WKWebView for acceptance.'}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    if any('error' in report or 'timeoutSeconds' in report for report in reports):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
