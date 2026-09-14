#!/usr/bin/env python3
"""Launch the real release app, collect its report and scoped process samples."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
import uuid

from fixtures import require_owned


def tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted((root / '.trellis').rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(root)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def processes():
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,time=,rss=,comm='], text=True)
    rows = []
    for line in output.splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5:
            continue
        pid, parent, cpu, rss, command = fields
        days, separator, remainder = cpu.partition('-')
        seconds = float(days) * 86400 if separator else 0.0
        clock = remainder if separator else cpu
        clock_seconds = 0.0
        for part in clock.split(':'):
            clock_seconds = clock_seconds * 60 + float(part)
        seconds += clock_seconds
        rows.append({'pid': int(pid), 'parent': int(parent), 'cpuSeconds': seconds,
                     'rssKiB': int(rss), 'command': command})
    return rows


def new_reports(directory, seen, label):
    """Do not let an incomplete/unrelated file starve this process's reports."""
    found = []
    for path in sorted(set(directory.glob('*.json')) - seen):
        try:
            candidate = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(candidate, dict) or candidate.get('label') != label:
            seen.add(path)
            continue
        found.append((path, candidate))
    return found


def stop_process(process, timeout):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--other-project', type=Path, action='append', default=[])
    parser.add_argument('--label', required=True)
    parser.add_argument('--binary', type=Path, default=Path('src-tauri/target/release/bundle/macos/Trellis Viewer.app/Contents/MacOS/trellis-viewer'))
    parser.add_argument('--timeout', type=float, default=360)
    parser.add_argument('--idle-seconds', type=float, default=60)
    parser.add_argument('--reports', type=int, default=1, help='Run repeated suites automatically in the same process')
    parser.add_argument('--scroll-seconds', type=int, default=60)
    parser.add_argument('--mutate', action='store_true')
    parser.add_argument('--mutate-document', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.reports <= 5 or not 3 <= args.scroll_seconds <= 120:
        parser.error('reports must be 1..5 and scroll-seconds must be 3..120')
    if not args.label or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in args.label):
        parser.error('label must contain only letters, numbers, hyphens and underscores')
    if not math.isfinite(args.timeout) or not math.isfinite(args.idle_seconds) or args.timeout <= args.idle_seconds or args.idle_seconds < 0:
        parser.error('timeout must be finite and greater than nonnegative idle-seconds')
    if not args.binary.is_file():
        parser.error(f'application binary not found: {args.binary}')
    if args.mutate_document:
        args.mutate = True
    project = args.project.resolve()
    require_owned(project)
    registered = [project] + [p.resolve() for p in args.other_project]
    if len(set(registered)) != len(registered):
        parser.error('registered project paths must be distinct')
    for path in registered:
        require_owned(path)
    output = Path('.perf-results') / args.label
    output.mkdir(parents=True, exist_ok=False)
    reports = Path.home() / 'Library/Application Support/local.trellis.viewer/performance'
    existing = set(reports.glob('*.json'))
    before = tree_digest(project)
    binary_sha256 = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    other_before = {str(path): tree_digest(path) for path in registered[1:]}
    initial_pids = {row['pid'] for row in processes()}
    report_label = f'{args.label}:{uuid.uuid4()}'
    env = dict(os.environ, TRELLIS_PERF_PROJECTS=json.dumps([str(p) for p in registered]),
               TRELLIS_PERF_AUTORUN='1', TRELLIS_PERF_LABEL=report_label,
               TRELLIS_PERF_REPEATS=str(args.reports), TRELLIS_PERF_SECONDS=str(args.scroll_seconds))
    samples = []
    started = time.monotonic()
    report = None
    report_count = 0
    invalid_report = None
    report_markers = []
    mutator = None
    idle_start = None
    idle_completed = False
    collection_error = None
    with (output / 'app.log').open('w') as log:
        app = subprocess.Popen([str(args.binary.resolve())], env=env, stdout=log, stderr=log)
        try:
            if args.mutate:
                mutation_args = ['python3', 'scripts/fixtures.py', 'mutate', '--out', str(project),
                                 '--seconds', str(args.timeout), '--rate', '20']
                if args.mutate_document:
                    mutation_args.append('--document')
                mutator = subprocess.Popen(mutation_args, stdout=log, stderr=log)
            idle_start = None
            while time.monotonic() - started < args.timeout:
                if app.poll() is not None:
                    raise RuntimeError(f'App exited before collection: {app.returncode}')
                if mutator is not None and mutator.poll() is not None:
                    raise RuntimeError(f'Fixture mutator stopped before workload completed: {mutator.returncode}')
                rows = processes()
                descendants = {app.pid}
                while True:
                    expanded = descendants | {r['pid'] for r in rows if r['parent'] in descendants}
                    if expanded == descendants:
                        break
                    descendants = expanded
                selected = [dict(row, attribution='descendant' if row['pid'] in descendants else 'new-webkit-candidate')
                            for row in rows if row['pid'] in descendants or
                            (row['pid'] not in initial_pids and 'WebKit' in row['command'])]
                samples.append({'elapsed': time.monotonic() - started, 'phase': 'idle' if idle_start else 'benchmark',
                                'processes': selected})
                if idle_start is None:
                    for path, candidate in new_reports(reports, existing, report_label):
                        report = candidate
                        report_count += 1
                        report_name = 'frontend-report.json' if report_count == 1 else f'frontend-report-{report_count:02d}.json'
                        (output / report_name).write_text(json.dumps(report, ensure_ascii=False, indent=2))
                        existing.add(path)
                        sampling = report.get('sampling')
                        valid = isinstance(sampling, dict) and sampling.get('valid') is True
                        report_markers.append({'report': report_name, 'elapsed': time.monotonic() - started,
                                               'status': report.get('status'), 'valid': valid})
                        if report.get('status') != 'completed' or not valid:
                            invalid_report = report.get('error') or 'Native report is aborted or sampling is invalid'
                            break
                        if report_count >= args.reports:
                            stop_process(mutator, 5)
                            mutator = None
                            idle_start = time.monotonic()
                            break
                if invalid_report:
                    break
                if idle_start is not None and time.monotonic() - idle_start >= args.idle_seconds:
                    idle_completed = True
                    break
                time.sleep(1)
        except Exception as error:
            collection_error = str(error)
        finally:
            # Always attempt both cleanups, including a mutator that ignores terminate.
            for child, timeout in ((mutator, 5), (app, 10)):
                try:
                    stop_process(child, timeout)
                except Exception as error:
                    collection_error = collection_error or f'Child cleanup failed: {error}'
            after = tree_digest(project)
            readonly = before == after if not args.mutate else None
            inactive_unchanged = all(tree_digest(Path(p)) == value for p, value in other_before.items())
            collection_valid = report_count == args.reports and idle_completed and not invalid_report and not collection_error and readonly is not False and inactive_unchanged
            metadata = {'label': args.label, 'reportLabel': report_label, 'collectionValid': collection_valid, 'collectionError': collection_error,
                        'idleCompleted': idle_completed, 'requestedIdleSeconds': args.idle_seconds,
                        'observedIdleSeconds': max(0, started + samples[-1]['elapsed'] - idle_start) if idle_start is not None and samples else 0, 'project': str(project), 'registeredProjects': len(registered), 'samples': samples,
                        'binarySha256': binary_sha256,
                        'reportCollected': report is not None, 'durationSeconds': time.monotonic() - started,
                        'reportCount': report_count, 'expectedReports': args.reports,
                        'reportMarkers': report_markers, 'invalidReport': invalid_report,
                        'readOnlyDigestBefore': before, 'readOnlyDigestAfter': after,
                        'readOnlyVerified': readonly,
                        'inactiveProjectsUnchanged': inactive_unchanged,
                        'externalMutation': args.mutate,
                        'externalDocumentMutation': args.mutate_document,
                        'limitations': ['New WebKit processes are candidates, not proven descendants; unrelated new WebKit activity can contaminate totals.',
                                        'Cold process launch does not clear the operating system file cache.',
                                        'Programmatic frame sampling does not measure physical input latency.']}
            (output / 'native-samples.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    print(json.dumps({'output': str(output.resolve()), 'reportCollected': report is not None, 'readOnlyVerified': metadata['readOnlyVerified']}))
    if collection_error:
        raise SystemExit(f'Native collection failed; artifacts saved: {collection_error}')
    if invalid_report:
        raise SystemExit(f'Invalid native sampling; artifacts saved: {invalid_report}')
    if report_count < args.reports:
        raise SystemExit('Timed out before all native reports; inspect app.log')
    if not idle_completed:
        raise SystemExit('Timed out before required idle observation completed')
    if not collection_valid:
        raise SystemExit('Read-only verification failed; artifacts saved')


if __name__ == '__main__':
    main()
