#!/usr/bin/env python3
"""Run the foreground native performance matrix sequentially; stop on invalid sampling."""
import argparse
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', required=True, help='New result label prefix, e.g. final-1')
    parser.add_argument('--suites', nargs='+', choices=['daily', 'baseline', 'stress', 'soak'],
                        default=['daily', 'baseline', 'stress', 'soak'])
    args = parser.parse_args()
    if not args.prefix or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in args.prefix):
        parser.error('prefix must contain only letters, numbers, hyphens and underscores')
    if len(set(args.suites)) != len(args.suites):
        parser.error('each suite may be requested only once')
    workspace = Path(__file__).resolve().parent.parent
    registered = [workspace / '.perf-fixtures/registered' / f'project-{i:02d}' for i in range(1, 20)]
    plans = {
        'daily': ['--project', '.perf-fixtures/daily'],
        'baseline': ['--project', '.perf-fixtures/baseline', '--mutate'],
        'stress': ['--project', '.perf-fixtures/stress', '--idle-seconds', '10'],
        'soak': ['--project', '.perf-fixtures/baseline', '--mutate-document',
                 '--reports', '5', '--scroll-seconds', '120', '--timeout', '900'],
    }
    for suite in args.suites:
        destination = workspace / '.perf-results' / f'{args.prefix}-{suite}'
        if destination.exists():
            parser.error(f'result directory already exists: {destination}')
    for suite in args.suites:
        command = [sys.executable, 'scripts/native_perf.py', '--label', f'{args.prefix}-{suite}', *plans[suite]]
        if suite in ('baseline', 'soak'):
            for path in registered:
                command.extend(['--other-project', str(path)])
        print(f'Starting {suite}; keep Trellis Viewer foreground. Invalid sampling stops the matrix.', flush=True)
        subprocess.run(command, cwd=workspace, check=True)


if __name__ == '__main__':
    main()
