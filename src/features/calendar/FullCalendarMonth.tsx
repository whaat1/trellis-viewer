import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin, { Draggable } from '@fullcalendar/interaction';
import zhCnLocale from '@fullcalendar/core/locales/zh-cn';
import type { EventApi, EventInput } from '@fullcalendar/core';
import type { ScheduleEntry, ScheduleUpdate } from '../../generated/contracts';
import { calendarWindow, fromCalendarRange, toCalendarRange } from './calendar-adapter';
import { localDate, parseLocalDate } from './model';
import { ParentTaskIcon } from './ParentTaskIcon';

export interface CalendarItem {
  entry: ScheduleEntry;
  taskKey: string;
  title: string;
  projectName: string;
  color: string;
  historical: boolean;
  editable: boolean;
  isParent: boolean;
  progress?: { completed: number; total: number };
}
export interface CalendarNavigation { goTo: (date: string) => void }
interface Props {
  ref: Ref<CalendarNavigation>;
  items: CalendarItem[];
  pendingRef: RefObject<HTMLElement | null>;
  saving: boolean;
  selectedDate: string;
  onMonth: (month: string) => void;
  onSelect: (date: string) => void;
  onEdit: (entry: ScheduleEntry) => void;
  onMore: (date: string) => void;
  onSave: (input: ScheduleUpdate) => Promise<void>;
  onError: (message: string) => void;
}
interface Anchor { date: string; offset: number }
const supportedRange = toCalendarRange({ startDate: '0001-01-01', endDate: '9999-12-31' });
function errorMessage(failure: unknown) { return failure instanceof Error ? failure.message : String(failure); }

/** FullCalendar owns date geometry and gestures; this wrapper only pages its
 * bounded date window and restores a civil-day/pixel scroll anchor. */
export function FullCalendarMonth(props: Props) {
  const { ref, items, pendingRef, saving, selectedDate } = props;
  const latest = useRef(props);
  latest.current = props;
  const calendar = useRef<FullCalendar>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState(() => calendarWindow(localDate(new Date())));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const restore = useRef<Anchor | null>({ date: localDate(new Date()), offset: 0 });
  const interaction = useRef(false);
  const calendarGesture = useRef(false);
  const cancelled = useRef(false);
  const clearing = useRef<string | null>(null);
  const saveBusy = useRef(false);
  const scrollFrame = useRef(0);
  const monthRef = useRef('');
  const reportScroll = useRef<() => void>(() => {});
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cellFor = useCallback((date: string) => scroller.current?.querySelector<HTMLElement>(`.fc-daygrid-day[data-date="${date}"]`), []);
  const viewportTop = useCallback(() => {
    const element = scroller.current;
    return element ? element.getBoundingClientRect().top + (element.querySelector<HTMLElement>('.fc-col-header')?.offsetHeight ?? 0) : 0;
  }, []);
  const captureAnchor = useCallback((): Anchor | null => {
    const top = viewportTop();
    const cells = scroller.current?.querySelectorAll<HTMLElement>('.fc-daygrid-body tbody > tr > td:first-child[data-date]');
    if (!cells) return null;
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      if (rect.bottom > top + 1) return { date: cell.dataset.date!, offset: rect.top - top };
    }
    return null;
  }, [viewportTop]);
  const restoreAnchor = useCallback((anchor: Anchor) => {
    const element = scroller.current;
    const cell = cellFor(anchor.date);
    if (element && cell) element.scrollTop += cell.getBoundingClientRect().top - viewportTop() - anchor.offset;
  }, [cellFor, viewportTop]);
  function goTo(date: string) {
    if (interaction.current || saveBusy.current || !parseLocalDate(date)) return;
    const anchor = { date, offset: 0 };
    if (cellFor(date)) {
      restoreAnchor(anchor);
      reportScroll.current();
    } else {
      restore.current = anchor;
      setRange(calendarWindow(date));
    }
  }
  useImperativeHandle(ref, () => ({ goTo }));

  reportScroll.current = () => {
    const element = scroller.current;
    if (!element || restore.current) return;
    const anchor = captureAnchor();
    if (!anchor) return;
    // The middle weekday represents a partial month-start week most naturally.
    const row = cellFor(anchor.date)?.parentElement;
    const representative = row?.querySelectorAll<HTMLElement>('[data-date]')[3]?.dataset.date ?? anchor.date;
    const month = `${representative.slice(0, 7)}-01`;
    if (month !== monthRef.current) { monthRef.current = month; latest.current.onMonth(month); }
    if (interaction.current || saveBusy.current) return;
    const buffer = element.clientHeight * 1.5;
    if (element.scrollTop < buffer || element.scrollHeight - element.scrollTop - element.clientHeight < buffer) {
      const next = calendarWindow(anchor.date);
      if (next.start.getTime() !== rangeRef.current.start.getTime()) {
        restore.current = anchor;
        setRange(next);
      }
    }
  };
  useLayoutEffect(() => {
    if (restore.current) { restoreAnchor(restore.current); restore.current = null; }
    reportScroll.current();
  }, [range, restoreAnchor]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    function onScroll() {
      if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = 0; reportScroll.current(); });
    }
    const observer = new ResizeObserver(() => {
      const anchor = captureAnchor();
      element!.style.setProperty('--calendar-week-height', `${Math.max(90, (element!.clientHeight - 30) / 5.5)}px`);
      calendar.current?.getApi().updateSize();
      if (anchor) restoreAnchor(anchor);
    });
    observer.observe(element);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', onScroll); cancelAnimationFrame(scrollFrame.current); };
  }, [captureAnchor, restoreAnchor]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const draggable = new Draggable(pending, {
      itemSelector: '.calendar-pending-task:not(:disabled)', minDistance: 6,
      eventData: element => ({ title: element.dataset.title ?? '', duration: { days: 1 }, create: false }),
    });
    function pendingDown(event: PointerEvent) {
      if ((event.target as Element).closest('.calendar-pending-task:not(:disabled)')) { interaction.current = true; cancelled.current = false; }
    }
    function pointerUp() {
      clearTimeout(releaseTimer.current);
      releaseTimer.current = setTimeout(() => { if (!calendarGesture.current) { interaction.current = false; pending?.classList.remove('is-recycle-target'); reportScroll.current(); } }, 0);
    }
    function pointerMove(event: PointerEvent) {
      if (!interaction.current || !clearing.current) return;
      const rect = pending!.getBoundingClientRect();
      pending!.classList.toggle('is-recycle-target', !cancelled.current && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    }
    function cancel() { cancelled.current = true; pending?.classList.remove('is-recycle-target'); }
    function keydown(event: KeyboardEvent) { if (interaction.current && event.key === 'Escape') cancel(); }
    pending.addEventListener('pointerdown', pendingDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', keydown);
    return () => {
      draggable.destroy(); clearTimeout(releaseTimer.current);
      pending.classList.remove('is-recycle-target');
      pending.removeEventListener('pointerdown', pendingDown);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', keydown);
    };
  }, [pendingRef]);

  const itemMap = useMemo(() => new Map(items.map(item => [item.entry.id, item])), [items]);
  const events = useMemo<EventInput[]>(() => items.filter(item => { const dates = toCalendarRange(item.entry); return dates.end > range.start && dates.start < range.end; }).map(item => ({
    id: item.entry.id, title: item.title, ...toCalendarRange(item.entry), allDay: true,
    editable: item.editable && !saving, classNames: item.historical ? ['is-historical'] : [],
    backgroundColor: `color-mix(in srgb, ${item.color} 18%, var(--surface))`, borderColor: item.color, textColor: 'var(--ink)',
  })), [items, range, saving]);

  async function persist(input: ScheduleUpdate, revert?: () => void) {
    if (cancelled.current || latest.current.saving || saveBusy.current) { revert?.(); return; }
    saveBusy.current = true; latest.current.onError('');
    try { await latest.current.onSave(input); }
    catch (failure) { revert?.(); latest.current.onError(errorMessage(failure)); }
    finally { saveBusy.current = false; reportScroll.current(); }
  }
  function saveEvent(event: EventApi, revert: () => void) {
    const item = itemMap.get(event.id);
    if (!item || !item.editable || clearing.current === `clear:${event.id}` || cancelled.current) { revert(); return; }
    try {
      const dates = fromCalendarRange(event.start, event.end);
      latest.current.onSelect(dates.startDate);
      void persist({ id: event.id, projectId: item.entry.projectId, taskKey: item.taskKey, ...dates }, revert);
    } catch (failure) { revert(); latest.current.onError(errorMessage(failure)); }
  }
  function beginInteraction(id?: string) { calendarGesture.current = true; interaction.current = true; cancelled.current = false; clearing.current = id ?? null; }
  function finishInteraction() { calendarGesture.current = false; interaction.current = false; pendingRef.current?.classList.remove('is-recycle-target'); }

  return <div className="calendar-continuous-scroll" ref={scroller} aria-label="连续月份日历">
    <FullCalendar ref={calendar} plugins={[dayGridPlugin, interactionPlugin]} locale={zhCnLocale}
      initialView="dayGrid" initialDate={new Date()} visibleRange={range} validRange={supportedRange} headerToolbar={false}
      height="auto" timeZone="local" firstDay={0} fixedWeekCount={false} showNonCurrentDates={true}
      dayHeaderFormat={{ weekday: 'short' }} monthStartFormat={{ month: 'long', day: 'numeric' }}
      editable={!saving} eventStartEditable={!saving} eventDurationEditable={!saving} eventResizableFromStart
      droppable={!saving} eventDragMinDistance={6} dragRevertDuration={150} dayMaxEvents={3}
      eventDisplay="block" displayEventTime={false} events={events}
      moreLinkText={count => `+${count} 更多`}
      moreLinkClick={arg => { latest.current.onMore(localDate(arg.date)); return 'none'; }}
      dayCellClassNames={arg => localDate(arg.date) === selectedDate ? ['is-selected'] : []}
      dateClick={arg => { const date = localDate(arg.date); if (parseLocalDate(date)) latest.current.onSelect(date); }}
      eventClick={arg => { const item = itemMap.get(arg.event.id); if (item) latest.current.onEdit(item.entry); }}
      eventContent={arg => {
        const item = itemMap.get(arg.event.id);
        const dates = fromCalendarRange(arg.event.start, arg.event.end);
        // didMount does not rerun when an existing event changes dates.
        return <div className="fc-event-main-frame" title={`${item?.projectName ?? ''} · ${arg.event.title}\n${dates.startDate} — ${dates.endDate}`} aria-label={`${arg.event.title}，${dates.startDate} 至 ${dates.endDate}`}><div className="fc-event-title-container"><div className="fc-event-title fc-sticky calendar-event-title">{item?.isParent && <ParentTaskIcon/>}<span>{arg.event.title}</span>{item?.isParent && item.progress && <small className="calendar-event-progress">{item.progress.completed}/{item.progress.total}</small>}</div></div></div>;
      }}
      eventDidMount={arg => { arg.el.dataset.scheduleId = arg.event.id; }}
      eventAllow={arg => {
        if (cancelled.current || saving || saveBusy.current) return false;
        try { fromCalendarRange(arg.start, arg.end); return true; } catch { return false; }
      }}
      eventDragStart={arg => beginInteraction(arg.event.id)}
      eventResizeStart={() => beginInteraction()}
      eventResizeStop={finishInteraction}
      eventDrop={arg => { saveEvent(arg.event, arg.revert); finishInteraction(); }}
      eventResize={arg => { saveEvent(arg.event, arg.revert); finishInteraction(); }}
      eventDragStop={arg => {
        const rect = pendingRef.current?.getBoundingClientRect();
        const { clientX: x, clientY: y } = arg.jsEvent;
        const item = itemMap.get(arg.event.id);
        if (!cancelled.current && item && rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          // This callback precedes eventDrop. Keep a synchronous guard so a
          // border hit cannot both clear the schedule and move its dates.
          clearing.current = `clear:${arg.event.id}`;
          void persist({ id: item.entry.id, projectId: item.entry.projectId, taskKey: item.taskKey, startDate: null, endDate: null });
        }
        finishInteraction();
      }}
      drop={arg => {
        const { projectId, pendingTask } = arg.draggedEl.dataset;
        if (projectId && pendingTask) {
          const date = localDate(arg.date);
          latest.current.onSelect(date);
          void persist({ id: null, projectId, taskKey: pendingTask, startDate: date, endDate: date });
        }
        finishInteraction();
      }}/>
  </div>;
}
