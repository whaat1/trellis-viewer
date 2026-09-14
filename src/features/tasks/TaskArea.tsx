import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore, selectRoot, setFilter, toggleExpanded, selectDocument } from '../../state/store';
import { childGroupCollapseId, flattenTree, statuses, statusLabel, taskStatus, projectProgress, projectStatusGroups as PROJECT_STATUS_GROUPS } from '../../state/model';
import type { TaskSummary } from '../../generated/contracts';
import { WorkspaceIcon } from '../../app/WorkspaceIcon';
import './tasks.css';

const TASK_ROW_HEIGHT = 72;
const MIN_CARD_WIDTH = 192;
const TaskCard = memo(function TaskCard({ task, selected }: { task: TaskSummary; selected: boolean }) {
  return <button className={`task-card ${selected ? 'selected' : ''} ${task.archived ? 'archived' : ''}`} role="tab" aria-selected={selected} data-task-key={task.key} onClick={() => selectRoot(task.key)} title={task.title}>
    <span className="task-card-top"><span className={`status-dot status-${taskStatus(task)}`}/><span className="task-card-kind">{task.childKeys.length ? `父任务 · ${task.childKeys.length} 个子任务` : '独立任务'}</span><span className="task-card-state">{statusLabel(task)}</span></span>
    <strong>{task.title}</strong>
  </button>;
});
export function TaskArea() {
  const index = useStore(s => s.index); const filter = useStore(s => s.filter); const selected = useStore(s => s.rootKey);
  const scroll = useRef<HTMLDivElement>(null); const [columns, setColumns] = useState(3);
  const roots = useMemo(() => index?.rootKeys.map(key => index.tasks[key]).filter(Boolean) ?? [], [index?.rootKeys, index?.tasks]);
  const counts = useMemo(() => { const map: Record<string, number> = { all: roots.length }; for (const task of roots) { const status = taskStatus(task); map[status] = (map[status] ?? 0) + 1; } return map; }, [roots]);
  const tasks = useMemo(() => filter === 'all' ? roots : roots.filter(task => taskStatus(task) === filter), [roots, filter]);
  const entities = index?.tasks;
  const progress = useMemo(() => projectProgress(entities), [entities]);
  const completionExplanation = `整体完成度：已完成 ${progress.completed} 项 ÷ 有效任务 ${progress.total} 项。仅统计最末级子任务和独立任务，包含归档；父任务只作分组，不重复计数。已取消任务不参与统计，其他归档任务仍按记录的完成状态判断。`;
  const statusDescription = PROJECT_STATUS_GROUPS.filter(([key]) => progress.statusCounts[key]).map(([key, label]) => `${label} ${progress.statusCounts[key]}`).join('，');
  useEffect(() => { const element = scroll.current; if (!element) return; const observer = new ResizeObserver(([entry]) => setColumns(Math.max(1, Math.floor((entry.contentRect.width + 8) / (MIN_CARD_WIDTH + 8))))); observer.observe(element); return () => observer.disconnect(); }, []);
  const virtual = useVirtualizer({ count: Math.ceil(tasks.length / columns), getScrollElement: () => scroll.current, estimateSize: () => TASK_ROW_HEIGHT, overscan: 2 });
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [filter]);
  return <section className="task-area compact-task-area" aria-label="父任务与独立任务">
    <div className="task-area-heading">
      <h1>任务空间</h1>
      <div className="status-tabs" role="tablist" aria-label="任务状态筛选" title="筛选父任务与独立任务，数量只统计顶层任务">{statuses.map(([key, label]) => <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)} data-status-filter={key}>{label}<span>{counts[key] ?? 0}</span></button>)}</div>
    </div>
    <div className="project-task-progress">
      <div className="project-status-meter" role="img" aria-label={`实际任务状态（含归档、不含分组）：${statusDescription || '暂无任务'}`} title={statusDescription || '暂无任务'}>
        {PROJECT_STATUS_GROUPS.filter(([key]) => progress.statusCounts[key]).map(([key, label]) => <span key={key} className={`project-status-segment status-${key}`} style={{ width: `${progress.statusCounts[key] / progress.total * 100}%` }} title={`${label} ${progress.statusCounts[key]}`}/>)}
      </div>
      <span className="project-completion" role="meter" aria-label="项目整体完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={`${progress.percent}% 已完成`} title={completionExplanation}><strong>{progress.percent}%</strong><span>完成</span></span>
    </div>
    <div className="project-status-legend" aria-label="实际任务状态数量（含归档、不含分组）" title={completionExplanation}>
      {PROJECT_STATUS_GROUPS.filter(([key]) => progress.statusCounts[key]).map(([key, label]) => <span key={key}><i className={`status-dot status-${key}`}/>{label}<b>{progress.statusCounts[key]}</b></span>)}
      {!progress.total && <span>暂无任务</span>}
    </div>
    <div className="task-grid-scroll" ref={scroll} data-perf-scroll="tasks"><div style={{ height: virtual.getTotalSize(), position: 'relative' }} role="tablist" aria-label="任务选项卡">
      {virtual.getVirtualItems().map(row => <div className="task-grid-row" key={row.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: TASK_ROW_HEIGHT, transform: `translateY(${row.start}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{tasks.slice(row.index * columns, (row.index + 1) * columns).map(task => <TaskCard key={task.key} task={task} selected={task.key === selected}/>)}</div>)}
    </div>{!tasks.length && <div className="no-tasks">这个状态下还没有任务</div>}</div>
  </section>;
}
export function TaskTree() {
  const index = useStore(s => s.index); const rootKey = useStore(s => s.rootKey); const docs = useStore(s => s.docs); const expanded = useStore(s => s.expanded); const selected = useStore(s => s.selectedDoc);
  const scroll = useRef<HTMLDivElement>(null);
  const tasks = index?.tasks;
  const rows = useMemo(() => tasks ? flattenTree(tasks, rootKey, docs, expanded) : [], [tasks, rootKey, docs, expanded]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 36, getItemKey: i => rows[i].id, overscan: 6 });
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [rootKey]);
  return <aside className="task-tree pane" aria-label="子任务和文档"><header className="pane-header"><strong>任务目录</strong><span className="spacer"/><span className="subtle">{index?.tasks[rootKey]?.childKeys.length ?? 0} 个子任务</span></header>
    <div className="tree-scroll" ref={scroll} data-perf-scroll="tree" role="tree" aria-label="任务文档树"><div style={{ position: 'relative', height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map(item => {
        const row = rows[item.index];
        const active = row.kind === 'document' && selected?.taskKey === row.taskKey && selected.key === row.documentKey;
        const task = index?.tasks[row.taskKey];
        const childTask = row.kind === 'task' && row.taskKey !== rootKey;
        const completed = childTask && (task?.status === 'completed' || task?.status === 'done');
        const cancelled = childTask && task?.status === 'cancelled';
        const status = `${completed ? '已完成' : cancelled ? '已取消' : '未完成'}${task?.archived ? ' · 已归档' : ''}`;
        const Row = row.expandable || row.kind === 'document' ? 'button' : 'div';
        const hint = row.summary ? `已完成 ${row.summary.completed} / 有效末级任务 ${row.summary.total}；包含归档，取消任务不计入。${row.summary.missing ? `另有 ${row.summary.missing} 项子任务暂不可用。` : ''}` : childTask ? `${row.label} · ${status}` : row.label;
        return <Row key={row.id} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.expandable ? row.open : undefined} aria-selected={row.kind === 'document' ? active : undefined} className={`tree-row ${row.kind} ${active ? 'active' : ''} ${row.taskKey === rootKey && row.kind === 'task' ? 'is-root' : ''} ${completed ? 'is-completed' : ''} ${cancelled ? 'is-cancelled' : ''}`} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 36, paddingLeft: 14 + row.depth * 16, transform: `translateY(${item.start}px)` }} title={hint} onClick={row.kind === 'document' ? () => selectDocument(row.taskKey, row.documentKey!) : row.expandable ? () => toggleExpanded(row.kind === 'children' ? childGroupCollapseId(rootKey) : row.id, row.kind === 'task' ? row.taskKey : undefined) : undefined}>
          <span className="tree-chevron">{row.expandable && <WorkspaceIcon name={row.open ? 'chevron-down' : 'chevron-right'} size={14}/>}</span>
          {childTask ? <span className={`tree-task-check ${completed ? 'is-checked' : ''}`} role="img" aria-label={status}>{completed ? <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m3 7 2.5 2.5L11 4"/></svg> : cancelled ? '−' : ''}</span> : <span className={`tree-icon ${row.kind}`}><WorkspaceIcon name={row.kind === 'document' ? 'file' : row.kind === 'folder' ? 'folder' : 'task'} size={row.kind === 'document' ? 16 : 14}/></span>}
          <span className="tree-label">{row.label}</span>
          {childTask && (task?.archived || cancelled) && <span className="tree-task-meta">{cancelled ? '已取消' : ''}{cancelled && task?.archived ? ' · ' : ''}{task?.archived ? '已归档' : ''}</span>}
        </Row>;
      })}
    </div>{!rows.length && <p className="tree-empty">选择上方的任务开始阅读</p>}</div>
  </aside>;
}
