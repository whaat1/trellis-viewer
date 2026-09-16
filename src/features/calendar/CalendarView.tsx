import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CalendarProject, PlannerSettings, Project, ScheduleEntry, ScheduleUpdate, TaskSummary } from '../../generated/contracts';
import { getProjectColor, resolveScheduledTask } from '../../state/planner';
import { ProjectColorPicker } from '../../app/ProjectColorPicker';
import { calendarTaskEditable, daysBetween, localDate, parentTaskDetails, pendingTasks, shiftMonth, validRange, type ParentTaskDetails } from './model';
import { FullCalendarMonth, type CalendarNavigation, type CalendarItem } from './FullCalendarMonth';
import { ParentTaskIcon } from './ParentTaskIcon';
import { ParentTaskChildren } from './ParentTaskChildren';
import './calendar.css';

export interface CalendarViewProps {
  projects: Project[];
  projectData: Record<string, CalendarProject>;
  settings: PlannerSettings;
  loading: boolean;
  saving: boolean;
  error: string;
  onRefresh: () => void;
  onSchedule: (input: ScheduleUpdate) => Promise<void>;
  onColor: (projectId: string, color: string) => Promise<void>;
  onOpenTask: (projectId: string, taskKey: string) => void;
}
interface EntryView { entry: ScheduleEntry; task?: TaskSummary; project?: Project; historical: boolean; editable: boolean; isParent: boolean; details?: ParentTaskDetails }
interface PendingGroup { project: Project; tasks: TaskSummary[]; taskMap: Map<string, TaskSummary>; parentDetails: Map<string, ParentTaskDetails>; loaded: boolean }
type PendingRow = { kind: 'project'; group: PendingGroup } | { kind: 'task'; group: PendingGroup; task: TaskSummary } | { kind: 'empty'; group: PendingGroup };
interface EditorItem { projectId: string; taskKey: string; title: string; entry?: ScheduleEntry; resolved: boolean; editable: boolean; isParent: boolean; parentTitle?: string; details?: ParentTaskDetails }
type EditorSelection = Pick<EditorItem, 'projectId' | 'taskKey' | 'title' | 'entry'>;
function colorStyle(color: string): CSSProperties { return { '--project-color': color } as CSSProperties; }
function message(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : '保存失败，请重试'; }
function shortDate(value: string) { return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`; }

function ScheduleEditor({ item, projectName, color, defaultDate, saving, onSave, onOpenTask, onClose }: {
  item: EditorItem; projectName: string; color: string; defaultDate: string; saving: boolean;
  onSave: (input: ScheduleUpdate) => Promise<void>; onOpenTask: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [startDate, setStartDate] = useState(item.entry?.startDate ?? defaultDate);
  const [endDate, setEndDate] = useState(item.entry?.endDate ?? defaultDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  const valid = validRange(startDate, endDate);
  async function save(clear = false) {
    if (!clear && !item.editable) { setError('这条历史排期仅支持查看和清除。'); return; }
    if (!clear && !valid) { setError('结束日期不得早于开始日期，请检查所选日期。'); return; }
    setBusy(true); setError('');
    try {
      await onSave({ id: item.entry?.id ?? null, projectId: item.projectId, taskKey: item.taskKey, startDate: clear ? null : startDate, endDate: clear ? null : endDate });
      onClose();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save(); }
  return <dialog ref={dialog} className="calendar-dialog schedule-editor" aria-labelledby="schedule-editor-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form onSubmit={submit}>
      <header><span className="calendar-project-caption" style={colorStyle(color)}><i/>{projectName}</span><button type="button" className="calendar-close" aria-label="关闭日期编辑器" disabled={busy} onClick={onClose}>×</button></header>
      <h2 id="schedule-editor-title">{item.isParent && <ParentTaskIcon/>}{item.title}</h2>
      {item.parentTitle && <p className="schedule-parent">{item.parentTitle}</p>}
      {!item.resolved && <p className="calendar-inline-notice">原任务暂时无法关联，历史排期已保留。你仍可清除这条排期。</p>}
      {item.resolved && !item.editable && <p className="calendar-inline-notice">这项任务已取消，历史排期已保留。你可以查看任务或清除排期。</p>}
      <div className="schedule-dates"><label>计划开始<input autoFocus type="date" value={startDate} onChange={event => setStartDate(event.target.value)} min="0001-01-01" max="9999-12-31" required disabled={busy || !item.editable}/></label><span>—</span><label>计划结束<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} min={startDate || '0001-01-01'} max="9999-12-31" required disabled={busy || !item.editable}/></label></div>
      <p className="schedule-hint">{valid ? `共 ${daysBetween(startDate, endDate) + 1} 天，包含开始和结束当天。` : '请设置有效日期，结束日期不得早于开始日期。'}</p>
      {item.details && <ParentTaskChildren details={item.details}/>}
      {error && <p className="calendar-inline-error" role="alert">{error}</p>}
      <footer><div>{item.entry && <button className="schedule-clear" type="button" disabled={busy || saving} onClick={() => void save(true)}>清除排期</button>}{item.resolved && <button className="schedule-open" type="button" disabled={busy} onClick={onOpenTask}>查看任务</button>}</div><button className="calendar-primary" type="submit" disabled={busy || saving || !valid || !item.editable}>{busy ? '保存中…' : item.entry ? '保存日期' : '安排任务'}</button></footer>
    </form>
  </dialog>;
}

function DayDetails({ date, entries, views, settings, onEdit, onClose }: {
  date: string; entries: ScheduleEntry[]; views: Map<string, EntryView>; settings: PlannerSettings; onEdit: (entry: ScheduleEntry) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  return <dialog ref={dialog} className="calendar-dialog calendar-day-details" aria-labelledby="calendar-day-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><h2 id="calendar-day-title">{shortDate(date)}<small>{entries.length} 项安排</small></h2><button autoFocus className="calendar-close" aria-label="关闭当天安排" onClick={onClose}>×</button></header>
    <div className="calendar-day-list">{entries.map(entry => { const view = views.get(entry.id); return <button key={entry.id} className={`calendar-day-entry ${view?.historical ? 'is-historical' : ''}`} style={colorStyle(getProjectColor(entry.projectId, settings))} onClick={() => onEdit(entry)}><i/><span><strong>{view?.isParent && <ParentTaskIcon/>}{view?.task?.title ?? entry.title}</strong><small>{view?.project?.name ?? '未登记项目'} · {shortDate(entry.startDate)} — {shortDate(entry.endDate)}{!view?.task ? ' · 待关联' : ''}</small></span><b>›</b></button>; })}</div>
  </dialog>;
}

export function CalendarView({ projects, projectData, settings, loading, saving, error, onRefresh, onSchedule, onColor, onOpenTask }: CalendarViewProps) {
  const today = localDate(new Date());
  const [month, setMonth] = useState(`${today.slice(0, 7)}-01`);
  const [selectedDate, setSelectedDate] = useState(today);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<EditorSelection | null>(null);
  const [moreDate, setMoreDate] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const calendarNavigation = useRef<CalendarNavigation>(null);
  const pendingSidebar = useRef<HTMLElement>(null);
  const pendingScroll = useRef<HTMLDivElement>(null);
  const projectModels = useMemo(() => new Map(Object.entries(projectData).map(([projectId, data]) => {
    const taskMap = new Map(data.tasks.map(task => [task.key, task]));
    const parentDetails = new Map(data.tasks.filter(task => task.parentKey === null && task.childKeys.length > 0).map(task => [task.key, parentTaskDetails(task, taskMap)]));
    return [projectId, { taskMap, parentDetails }];
  })), [projectData]);
  const { views, groups } = useMemo(() => {
    const views = new Map<string, EntryView>();
    const scheduledKeys = new Map<string, Set<string>>();
    const projectMap = new Map(projects.map(project => [project.id, project]));
    for (const entry of settings.schedules) {
      // 已移除项目的排期仍保存在设置中，但不再出现在活动日历。
      if (!projectMap.has(entry.projectId)) continue;
      const tasks = projectData[entry.projectId]?.tasks ?? [];
      const task = resolveScheduledTask(entry, tasks);
      const keys = scheduledKeys.get(entry.projectId) ?? new Set<string>();
      if (task) keys.add(task.key);
      else {
        // Ambiguous archive moves remain history, and their possible matches
        // stay out of pending to avoid silently creating a duplicate schedule.
        keys.add(entry.taskKey);
        const basename = entry.taskKey.split('/').pop();
        for (const candidate of tasks) if (candidate.key.split('/').pop() === basename) keys.add(candidate.key);
      }
      scheduledKeys.set(entry.projectId, keys);
      views.set(entry.id, { entry, task, project: projectMap.get(entry.projectId), historical: !task || task.archived || ['completed', 'done', 'cancelled'].includes(task.status), editable: calendarTaskEditable(task), isParent: !!task?.childKeys.length, details: task ? projectModels.get(entry.projectId)?.parentDetails.get(task.key) : undefined });
    }
    const groups = projects.map(project => {
      const data = projectData[project.id];
      return { project, tasks: pendingTasks(data?.tasks ?? [], scheduledKeys.get(project.id) ?? new Set()), taskMap: projectModels.get(project.id)?.taskMap ?? new Map(), parentDetails: projectModels.get(project.id)?.parentDetails ?? new Map(), loaded: !!data };
    });
    return { views, groups };
  }, [projects, projectData, projectModels, settings.schedules]);
  const rows = useMemo(() => {
    const result: PendingRow[] = [];
    const search = query.trim().toLocaleLowerCase();
    for (const source of groups) {
      const group = search ? { ...source, tasks: source.tasks.filter(task => `${source.project.name} ${task.title} ${source.taskMap.get(task.parentKey ?? '')?.title ?? ''}`.toLocaleLowerCase().includes(search)) } : source;
      result.push({ kind: 'project', group });
      if (collapsed.has(group.project.id)) continue;
      if (!group.tasks.length) result.push({ kind: 'empty', group });
      for (const task of group.tasks) result.push({ kind: 'task', group, task });
    }
    return result;
  }, [groups, collapsed, query]);
  const pendingCount = groups.reduce((count, group) => count + group.tasks.length, 0);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => pendingScroll.current, estimateSize: index => rows[index].kind === 'project' ? 45 : rows[index].kind === 'task' ? 54 : 32, getItemKey: index => rows[index].kind === 'task' ? `${rows[index].group.project.id}:task:${rows[index].task.key}` : `${rows[index].group.project.id}:${rows[index].kind}`, overscan: 6 });
  const calendarItems = useMemo<CalendarItem[]>(() => [...views.values()].map(view => ({
    entry: view.entry, taskKey: view.task?.key ?? view.entry.taskKey,
    title: view.task?.title ?? view.entry.title, projectName: view.project?.name ?? '未登记项目',
    color: getProjectColor(view.entry.projectId, settings), historical: view.historical, editable: view.editable, isParent: view.isParent, progress: view.details?.progress,
  })), [views, settings]);
  function navigate(delta: number) {
    const next = shiftMonth(month, delta); calendarNavigation.current?.goTo(next); setSelectedDate(next);
  }
  const editorItem = useMemo<EditorItem | null>(() => {
    if (!editor) return null;
    const model = projectModels.get(editor.projectId);
    const entry = editor.entry ? settings.schedules.find(item => item.id === editor.entry!.id) ?? editor.entry : undefined;
    const task = entry ? resolveScheduledTask(entry, projectData[editor.projectId]?.tasks ?? []) : model?.taskMap.get(editor.taskKey);
    return { ...editor, entry, title: task?.title ?? editor.title, taskKey: task?.key ?? editor.taskKey,
      resolved: !!task, editable: calendarTaskEditable(task), isParent: !!task?.childKeys.length,
      parentTitle: task?.parentKey ? model?.taskMap.get(task.parentKey)?.title : undefined,
      details: task?.childKeys.length && model ? model.parentDetails.get(task.key) ?? parentTaskDetails(task, model.taskMap) : undefined,
    };
  }, [editor, projectModels, projectData, settings.schedules]);
  function editEntry(entry: ScheduleEntry) {
    const view = views.get(entry.id);
    setMoreDate(null);
    setEditor({ projectId: entry.projectId, taskKey: view?.task?.key ?? entry.taskKey, title: view?.task?.title ?? entry.title, entry });
  }
  function editPending(group: PendingGroup, task: TaskSummary) { setEditor({ projectId: group.project.id, taskKey: task.key, title: task.title }); }
  async function changeColor(projectId: string, color: string) {
    setActionError('');
    try { await onColor(projectId, color); } catch (failure) { setActionError(message(failure)); }
  }
  const monthLabel = `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
  const diagnostics = Object.values(projectData).flatMap(data => data.diagnostics);
  return <section className="calendar-view" aria-label="所有项目月历">
    <div className="calendar-main">
      <header className="calendar-toolbar"><h1>{monthLabel}</h1><div className="calendar-navigation"><button aria-label="上个月" disabled={month === '0001-01-01'} onClick={() => navigate(-1)}>‹</button><button aria-label="下个月" disabled={month === '9999-12-01'} onClick={() => navigate(1)}>›</button><button className="calendar-today-button" onClick={() => { calendarNavigation.current?.goTo(today); setSelectedDate(today); }}>今天</button></div><span className="calendar-toolbar-spacer"/><span className="calendar-sync" role="status">{saving ? '保存中…' : loading ? '正在读取项目…' : '月视图'}</span><button className="calendar-refresh" aria-label="刷新所有项目任务" disabled={loading} onClick={onRefresh}>↻</button></header>
      {(actionError || error) && <div className="calendar-inline-error calendar-top-error" role="alert">{actionError || error}</div>}
      {!!diagnostics.length && <details className="calendar-diagnostics"><summary>{diagnostics.length} 条项目提示</summary>{diagnostics.slice(0, 20).map((text, index) => <p key={index}>{text}</p>)}</details>}
      <FullCalendarMonth ref={calendarNavigation} items={calendarItems} pendingRef={pendingSidebar} saving={saving} selectedDate={selectedDate} onMonth={setMonth} onSelect={setSelectedDate} onEdit={editEntry} onMore={setMoreDate} onSave={onSchedule} onError={setActionError}/>
    </div>
    <aside ref={pendingSidebar} className="calendar-pending" aria-label="待安排任务"><header><div><h2>安排任务</h2><span>{pendingCount} 项待安排</span></div><span className="calendar-pending-symbol">☷</span></header><p className="calendar-pending-help">拖入日期安排；拖回这里清除排期</p><label className="calendar-search"><span>⌕</span><input type="search" aria-label="搜索待安排任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="calendar-pending-scroll" ref={pendingScroll} role="list" aria-label="按项目分组的待安排任务"><div style={{ height: virtual.getTotalSize(), position: 'relative' }}>{virtual.getVirtualItems().map(item => {
        const row = rows[item.index]; const color = getProjectColor(row.group.project.id, settings);
        return <div key={item.key} className={`calendar-pending-row row-${row.kind}`} role="listitem" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)`, ...colorStyle(color) }}>
          {row.kind === 'project' ? <div className="calendar-project-group"><button className="calendar-group-toggle" aria-expanded={!collapsed.has(row.group.project.id)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(row.group.project.id)) next.delete(row.group.project.id); else next.add(row.group.project.id); return next; })}><span className="calendar-group-chevron">{collapsed.has(row.group.project.id) ? '›' : '⌄'}</span><span className="calendar-group-name" title={row.group.project.name}>{row.group.project.name}</span><small>{row.group.loaded ? row.group.tasks.length : '…'}</small></button><ProjectColorPicker name={row.group.project.name} color={color} disabled={saving} onChange={value => changeColor(row.group.project.id, value)}/></div> : row.kind === 'empty' ? <p className="calendar-project-empty">{!row.group.loaded ? loading ? '正在读取…' : '未载入，请刷新重试' : query ? '没有匹配的任务' : '暂时没有待安排任务'}</p> : <button className="calendar-pending-task" data-pending-task={row.task.key} data-project-id={row.group.project.id} data-title={row.task.title} title={row.task.title} disabled={saving} onClick={() => editPending(row.group, row.task)}>{row.task.childKeys.length > 0 ? <ParentTaskIcon/> : <i/>}<span><strong>{row.task.title}</strong><small>{row.group.parentDetails.has(row.task.key) ? `${row.group.parentDetails.get(row.task.key)!.progress.completed}/${row.group.parentDetails.get(row.task.key)!.progress.total} 子任务已完成` : row.task.parentKey ? `子任务 · ${row.group.taskMap.get(row.task.parentKey)?.title ?? '父任务暂不可用'}` : '独立任务'}</small></span><b>⋮⋮</b></button>}
        </div>;
      })}</div>{!projects.length && <p className="calendar-project-empty">添加项目后，待安排任务会显示在这里。</p>}</div>
    </aside>
    {moreDate && <DayDetails date={moreDate} entries={settings.schedules.filter(entry => projects.some(project => project.id === entry.projectId) && validRange(entry.startDate, entry.endDate) && entry.startDate <= moreDate && entry.endDate >= moreDate)} views={views} settings={settings} onEdit={editEntry} onClose={() => setMoreDate(null)}/>}
    {editorItem && <ScheduleEditor key={editorItem.entry?.id ?? `${editorItem.projectId}:${editorItem.taskKey}`} item={editorItem} projectName={projects.find(project => project.id === editorItem.projectId)?.name ?? '未登记项目'} color={getProjectColor(editorItem.projectId, settings)} defaultDate={selectedDate} saving={saving} onSave={onSchedule} onClose={() => setEditor(null)} onOpenTask={() => { onOpenTask(editorItem.projectId, editorItem.taskKey); setEditor(null); }}/>}
  </section>;
}
