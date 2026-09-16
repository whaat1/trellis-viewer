import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TaskSummary } from '../../generated/contracts';
import { ParentTaskIcon } from './ParentTaskIcon';
import type { ParentTaskDetails } from './model';

function childStatus(task: TaskSummary) {
  const state = task.status === 'cancelled' ? '已取消' : task.status === 'completed' || task.status === 'done' ? '已完成' : task.status === 'planning' ? '规划中' : task.status === 'in_progress' ? '进行中' : task.status === 'review' ? '待审查' : '未知状态';
  return task.archived ? `${state} · 已归档` : state;
}
export function ParentTaskChildren({ details }: { details: ParentTaskDetails }) {
  const scroll = useRef<HTMLDivElement>(null);
  const { rows, progress, missingCount, repeatedCount } = details;
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 43, getItemKey: index => rows[index].key, overscan: 5 });
  const partial = missingCount > 0 || repeatedCount > 0;
  return <section className="calendar-children" aria-label="子任务完成情况">
    <header><h3>子任务</h3><span>{partial ? '已知任务 ' : ''}{progress.completed}/{progress.total} 已完成 <b>{progress.percent}%</b></span></header>
    <div className="calendar-children-progress" role="progressbar" aria-label="子任务完成度" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progress.percent}%` }}/></div>
    {partial && <p className="calendar-children-notice">{missingCount > 0 ? `${missingCount} 项子任务暂不可用。` : ''}{repeatedCount > 0 ? `${repeatedCount} 处重复或循环关系已略过。` : ''}完成度仅统计可读取的末级任务。</p>}
    <div ref={scroll} className="calendar-children-scroll" tabIndex={0} role="list" aria-label="只读子任务清单" style={{ height: Math.min(258, Math.max(43, rows.length * 43)) }}>
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>{virtual.getVirtualItems().map(item => {
        const row = rows[item.index];
        const task = row.task;
        const completed = task?.status === 'completed' || task?.status === 'done';
        const cancelled = task?.status === 'cancelled';
        return <div key={item.key} className={`calendar-child-row ${completed ? 'is-completed' : ''} ${cancelled ? 'is-cancelled' : ''}`} role="listitem" aria-level={row.depth + 1} data-depth={row.depth} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)`, paddingLeft: 2 + Math.min(row.depth, 8) * 13 }}>
          <span className={`calendar-child-check ${completed ? 'is-checked' : ''}`} role="img" aria-label={completed ? '已完成' : cancelled ? '已取消' : '未完成'}>{completed ? '✓' : cancelled ? '−' : ''}</span>
          <span className="calendar-child-title" title={task?.title ?? row.key}>{!!task?.childKeys.length && <ParentTaskIcon/>}<span>{task?.title ?? '任务暂不可用'}</span></span>
          <small>{row.depth > 8 ? `第 ${row.depth + 1} 级 · ` : ''}{task ? childStatus(task) : row.key}</small>
        </div>;
      })}</div>
    </div>
    <p className="calendar-children-hint">完成情况随项目更新；归档和取消任务不计入完成度。</p>
  </section>;
}
