import { snapTaskHeight } from './layout-sizing';
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { TaskArea, TaskTree } from '../features/tasks/TaskArea';
import { Reader } from '../features/documents/Reader';
import './workspace-layout.css';

type Axis = 'top' | 'tree';
type Sizes = Record<Axis, number>;
const defaults: Sizes = { top: 180, tree: 260 };
const storageKey = 'trellis.viewer.panes.v1';
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));


export function WorkspaceLayout() {
  const container = useRef<HTMLDivElement>(null);
  const horizontal = useRef<HTMLDivElement>(null);
  const vertical = useRef<HTMLDivElement>(null);
  const sizes = useRef<Sizes>({ ...defaults });
  const drag = useRef<{ axis: Axis; pointerId: number; coordinate: number; size: number } | null>(null);
  const bodyStyle = useRef<{ cursor: string; userSelect: string } | null>(null);
  const pending = useRef<{ axis: Axis; value: number } | null>(null);
  const frame = useRef(0);

  const bounds = useCallback((axis: Axis): [number, number] => {
    const element = container.current;
    if (!element) return [0, 0];
    if (axis === 'tree') return [180, Math.max(180, element.clientWidth - 327)];
    const section = element.querySelector<HTMLElement>('.task-area');
    const scroll = element.querySelector<HTMLElement>('.task-grid-scroll');
    const minimum = section && scroll ? Math.ceil(scroll.getBoundingClientRect().top - section.getBoundingClientRect().top + parseFloat(getComputedStyle(section).paddingBottom) + parseFloat(getComputedStyle(section).borderBottomWidth)) + 72 : 180;
    return [minimum, Math.max(minimum, element.clientHeight - 187)];
  }, []);
  const apply = useCallback((axis: Axis, value: number) => {
    const [min, max] = bounds(axis);
    const next = clamp(value, min, max);
    sizes.current[axis] = next;
    container.current?.style.setProperty(axis === 'top' ? '--tasks-height' : '--tree-width', `${next}px`);
    const divider = axis === 'top' ? horizontal.current : vertical.current;
    divider?.setAttribute('aria-valuemin', String(Math.round(min)));
    divider?.setAttribute('aria-valuemax', String(Math.round(max)));
    divider?.setAttribute('aria-valuenow', String(Math.round(next)));
  }, [bounds]);
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(sizes.current)); } catch { /* Layout still works without storage. */ }
  }
  function flush() {
    cancelAnimationFrame(frame.current); frame.current = 0;
    if (pending.current) { apply(pending.current.axis, pending.current.value); pending.current = null; }
  }
  function restoreCursor() {
    if (!bodyStyle.current) return;
    Object.assign(document.body.style, bodyStyle.current); bodyStyle.current = null;
  }
  function start(event: PointerEvent<HTMLDivElement>, axis: Axis) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { axis, pointerId: event.pointerId, coordinate: axis === 'top' ? event.clientY : event.clientX, size: sizes.current[axis] };
    bodyStyle.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    document.body.style.cursor = axis === 'top' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    event.currentTarget.dataset.dragging = 'true';
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    pending.current = { axis: current.axis, value: current.size + (current.axis === 'top' ? event.clientY : event.clientX) - current.coordinate };
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    flush();
    if (drag.current.axis === 'top') apply('top', snapTaskHeight(sizes.current.top, ...bounds('top')));
    drag.current = null; restoreCursor(); delete event.currentTarget.dataset.dragging; save();
  }
  function key(event: KeyboardEvent<HTMLDivElement>, axis: Axis) {
    const previous = axis === 'top' ? 'ArrowUp' : 'ArrowLeft';
    const next = axis === 'top' ? 'ArrowDown' : 'ArrowRight';
    if (![previous, next, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const [min, max] = bounds(axis);
    const value = event.key === 'Home' ? min : event.key === 'End' ? max : sizes.current[axis] + (event.key === previous ? -1 : 1) * (axis === 'top' ? 72 : event.shiftKey ? 40 : 16);
    apply(axis, axis === 'top' ? snapTaskHeight(value, min, max) : value);
    save();
  }
  useLayoutEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as Partial<Sizes> | null;
      for (const axis of ['top', 'tree'] as const) {
        if (typeof saved?.[axis] === 'number' && Number.isFinite(saved[axis])) sizes.current[axis] = saved[axis]!;
      }
    } catch { /* Ignore invalid saved dimensions. */ }
    const resize = () => { if (!drag.current) apply('top', snapTaskHeight(sizes.current.top, ...bounds('top'))); apply('tree', sizes.current.tree); };
    resize();
    const observer = new ResizeObserver(resize);
    if (container.current) {
      observer.observe(container.current);
      // Project loading/status changes can wrap the legend without resizing
      // the workspace itself; preserve room for one full virtual card row.
      for (const element of container.current.querySelectorAll('.task-area-heading, .project-status-legend')) observer.observe(element);
    }
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); restoreCursor(); };
  }, [apply, bounds]);

  const dividerProps = (axis: Axis) => ({
    role: 'separator' as const, tabIndex: 0,
    'aria-label': axis === 'top' ? '调整任务区高度' : '调整目录区宽度',
    'aria-orientation': axis === 'top' ? 'horizontal' as const : 'vertical' as const,
    title: '拖动调整 · 双击恢复 · 方向键微调',
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => start(event, axis),
    onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => key(event, axis),
    onDoubleClick: () => { apply(axis, axis === 'top' ? bounds('top')[0] : defaults[axis]); save(); },
  });
  return <div ref={container} className="workspace-panes">
    <div className="task-pane"><TaskArea/></div>
    <div ref={horizontal} className="pane-divider horizontal" {...dividerProps('top')}/>
    <div className="reading-columns">
      <TaskTree/>
      <div ref={vertical} className="pane-divider vertical" {...dividerProps('tree')}/>
      <Reader/>
    </div>
  </div>;
}
