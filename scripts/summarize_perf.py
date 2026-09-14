#!/usr/bin/env python3
"""Summarize retained native samples without claiming ambiguous WebKit attribution."""
import argparse
import json
import re
from pathlib import Path


def summary(values):
    ordered = sorted(values)
    if not ordered:
        return None
    import math
    return {'samples': len(values), 'mean': sum(values) / len(values),
            'p95': ordered[math.ceil(len(values) * .95) - 1], 'max': ordered[-1]}


def summarize(directory):
    native = json.loads((directory / 'native-samples.json').read_text())
    samples = native['samples']
    idle_cpu = []
    process_cpu = []
    rss = []
    idle_rss = []
    for index, current in enumerate(samples):
        total_rss = sum(p['rssKiB'] for p in current['processes']) / 1024
        rss.append(total_rss)
        if current['phase'] == 'idle':
            idle_rss.append(total_rss)
        if index == 0 or current['phase'] != 'idle' or samples[index - 1]['phase'] != 'idle':
            continue
        previous = samples[index - 1]
        elapsed = current['elapsed'] - previous['elapsed']
        if elapsed <= 0:
            continue
        before = {p['pid']: p['cpuSeconds'] for p in previous['processes']}
        deltas = [(p, max(0, p['cpuSeconds'] - before[p['pid']])) for p in current['processes'] if p['pid'] in before]
        idle_cpu.append(sum(delta for _, delta in deltas) / elapsed * 100)
        process_cpu.append(sum(delta for p, delta in deltas if p['attribution'] == 'descendant') / elapsed * 100)
    result = {'label': native['label'], 'collectionValid': native.get('collectionValid'),
              'collectionError': native.get('collectionError'), 'idleCompleted': native.get('idleCompleted'),
              'requestedIdleSeconds': native.get('requestedIdleSeconds'), 'observedIdleSeconds': native.get('observedIdleSeconds'), 'readOnlyVerified': native['readOnlyVerified'],
              'durationSeconds': native['durationSeconds'],
              'reportCount': native.get('reportCount'), 'expectedReports': native.get('expectedReports'),
              'invalidReport': native.get('invalidReport'),
              'inactiveProjectsUnchanged': native.get('inactiveProjectsUnchanged'),
              'idleCpuPercentApp': summary(process_cpu), 'idleCpuPercentIncludingWebKitCandidates': summary(idle_cpu),
              'rssMiBIncludingWebKitCandidates': summary(rss),
              'idleRssMiBFirstLast': [idle_rss[0], idle_rss[-1]] if idle_rss else None,
              'attributionLimitation': native['limitations'][0]}
    result['reportRssMiBIncludingWebKitCandidates'] = [
        dict(marker, rssMiB=sum(p['rssKiB'] for p in min(samples, key=lambda s: abs(s['elapsed'] - marker['elapsed']))['processes']) / 1024)
        for marker in native.get('reportMarkers', []) if samples
    ]
    result['runs'] = []
    result['ignoredReports'] = []
    first_report = None
    expected_label = native.get('reportLabel', native['label'])
    for path in sorted(directory.glob('frontend-report*.json'), key=lambda p: (p.name != 'frontend-report.json', p.name)):
        if not re.fullmatch(r'frontend-report(?:-\d{2})?\.json', path.name):
            continue
        report = json.loads(path.read_text())
        if not isinstance(report, dict) or report.get('label') != expected_label:
            result['ignoredReports'].append({'file': path.name, 'reason': 'report label does not match this collection'})
            continue
        if first_report is None:
            first_report = report
        result['runs'].append({'file': path.name, 'status': report.get('status'), 'sampling': report.get('sampling'),
                               'projects': report.get('projects', [])})
    result['usableForegroundResults'] = (
        native.get('collectionValid') is True
        and len(result['runs']) == native.get('expectedReports')
        and bool(result['runs'])
        and all(run['status'] == 'completed' and isinstance(run['sampling'], dict) and run['sampling'].get('valid') is True
                for run in result['runs'])
    )
    if first_report is not None:
        result['runtime'] = first_report.get('runtime')
        result['projects'] = first_report.get('projects', [])
        batches = first_report.get('backendBatches', [])
        result['backend'] = {'batches': len(batches), 'fullScans': sum(b['fullScan'] for b in batches),
                             'elapsedMs': summary([b['elapsedMs'] for b in batches]),
                             'payloadBytes': summary([b['payloadBytes'] for b in batches])}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.directory), ensure_ascii=False, indent=2))
