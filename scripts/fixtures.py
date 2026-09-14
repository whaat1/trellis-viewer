#!/usr/bin/env python3
"""Generate or mutate owned Trellis fixtures. Never operate on user projects."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import random
import time

MARKER = '.trellis-viewer-fixture.json'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

def require_owned(root):
    marker = root / MARKER
    if not marker.is_file() or json.loads(marker.read_text()).get('owner') != 'trellis-viewer-performance':
        raise SystemExit(f'Refusing non-fixture directory: {root}')
    return json.loads(marker.read_text())

def generate(root, count):
    if root.exists() and any(root.iterdir()):
        require_owned(root)
        raise SystemExit(f'Fixture already exists; use a different --out: {root}')
    root.mkdir(parents=True, exist_ok=True)
    write_json(root / MARKER, {'owner': 'trellis-viewer-performance', 'count': count, 'createdAt': time.time()})
    taskroot = root / '.trellis' / 'tasks'
    taskroot.mkdir(parents=True)
    active_count = max(5, (count // 4 // 5) * 5)
    relative_dirs = []
    themes = ['用户登录', '工单查询', '权限管理', '通知提醒', '统计报表', '数据导出', '系统配置', '操作日志']
    for index in range(count):
        directory = f'09-11-task-{index:05d}'
        archived = index >= active_count
        rel = f'archive/2026-08/{directory}' if archived else directory
        relative_dirs.append(rel)
        path = taskroot / rel
        (path / 'research' / 'nested').mkdir(parents=True)
        group_start = index // 5 * 5
        is_child = index % 5 in (1, 2, 3)
        children = [f'09-11-task-{child:05d}' for child in range(index + 1, min(index + 4, count))] if index % 5 == 0 else []
        status = 'completed' if archived else ['in_progress', 'planning', 'review', 'completed'][index % 4]
        data = {
            'id': f'task-{index:05d}', 'name': f'task-{index:05d}',
            'title': f'{themes[index % len(themes)]} · {index + 1:04d}',
            'status': status, 'createdAt': '2026-09-11', 'priority': 'P1',
            'parent': f'09-11-task-{group_start:05d}' if is_child else None,
            'children': children, 'subtasks': [], 'notes': '基准数据，模拟本地任务元信息。' * 40,
        }
        write_json(path / 'task.json', data)
        prd = f'# {data["title"]}\n\n## 目标\n\n只读浏览任务状态，保持快速切换与清晰的文档排版。\n\n## 验收\n\n- [ ] 展示任务\n- [x] 保留原始文件\n\n| 字段 | 含义 |\n| --- | --- |\n| 状态 | {status} |\n\n'
        if index < 10:
            prd += ('### 功能说明\n\n支持多项目任务的只读浏览，操作后立即反馈，后台更新不打断阅读。\n\n' * 240)
        (path / 'prd.md').write_text(prd)
        (path / 'research' / 'nested' / 'notes.md').write_text('# 嵌套调研\n\n此文档验证任意层级的 Markdown 文件树。\n')
        if index == 0:
            baseline = '# 64 KiB document\n\n' + ('Readable task details and acceptance criteria.\n\n' * 1600)
            (path / 'baseline-64k.md').write_bytes(baseline.encode()[:65536])
            paragraph = '# 长文档 · 段落\n\n' + ''.join(f'## 第 {i} 节\n\n' + '任务数据在后台更新，阅读位置应保持稳定。' * 20 + '\n\n' for i in range(1100))
            (path / 'long-paragraphs.md').write_text(paragraph)
            table = '# 长表格\n\n| 编号 | 内容 | 状态 |\n| --- | --- | --- |\n' + ''.join(f'| {i} | 工单详情、处理意见与回访记录 | 进行中 |\n' for i in range(16000))
            (path / 'long-table.md').write_text(table)
            code = '# 长代码块\n\n```text\n' + ''.join(f'{i:06d} 任务索引与只读读取的测试行。\n' for i in range(26000)) + '```\n'
            (path / 'long-code.md').write_text(code)
            (path / 'image.png').write_bytes(base64.b64decode(PNG))
            (path / 'images.md').write_text('# 本地图片\n\n' + '\n\n'.join(f'![本地示例 {i}](image.png)' for i in range(30)))
    write_json(root / 'fixture-manifest.json', {'count': count, 'activeCount': active_count, 'tasks': relative_dirs})
    print(json.dumps({'project': str(root.resolve()), 'tasks': count, 'active': active_count}, ensure_ascii=False))

def mutate(root, seconds, rate, document=False):
    require_owned(root)
    manifest = json.loads((root / 'fixture-manifest.json').read_text())
    tasks = manifest['tasks'][:manifest['activeCount']]
    rng = random.Random(42)
    started = time.monotonic()
    index = 0
    body_path = root / '.trellis' / 'tasks' / tasks[0] / 'long-paragraphs.md'
    original_body = body_path.read_text() if document else ''
    while time.monotonic() - started < seconds:
        target = root / '.trellis' / 'tasks' / tasks[rng.randrange(len(tasks))] / 'task.json'
        data = json.loads(target.read_text())
        data['status'] = ['planning', 'in_progress', 'review', 'completed'][index % 4]
        data['notes'] = f'外部基准写入 {index}。' + data.get('notes', '')[-1500:]
        temp = target.with_suffix('.tmp')
        write_json(temp, data)
        os.replace(temp, target)
        index += 1
        if document and index % max(1, int(rate * 2)) == 0:
            temporary_body = body_path.with_suffix('.tmp')
            temporary_body.write_text(f'> 外部文档刷新 {index}\n\n' + original_body)
            os.replace(temporary_body, body_path)
        delay = started + index / rate - time.monotonic()
        if delay > 0:
            time.sleep(delay)
    print(json.dumps({'writes': index, 'seconds': round(time.monotonic() - started, 3), 'root': str(root)}))

def digest(root):
    require_owned(root)
    value = hashlib.sha256()
    count = 0
    for file in sorted((root / '.trellis').rglob('*')):
        if file.is_file():
            value.update(str(file.relative_to(root)).encode())
            value.update(file.read_bytes())
            count += 1
    print(json.dumps({'files': count, 'sha256': value.hexdigest(), 'root': str(root.resolve())}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['generate', 'mutate', 'digest'])
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--count', type=int, default=2000)
    parser.add_argument('--seconds', type=float, default=90)
    parser.add_argument('--rate', type=float, default=20)
    parser.add_argument('--document', action='store_true', help='Also refresh the first long document every two seconds')
    args = parser.parse_args()
    if args.count < 5 or args.rate <= 0 or args.seconds <= 0:
        parser.error('count >= 5, rate > 0, seconds > 0 required')
    if args.mode == 'generate': generate(args.out, args.count)
    elif args.mode == 'mutate': mutate(args.out, args.seconds, args.rate, args.document)
    else: digest(args.out)
