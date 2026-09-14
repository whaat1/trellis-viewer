import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { projectPalette } from '../state/planner';

export function ProjectColorPicker({ name, color, disabled, onChange }: {
  name: string; color: string; disabled: boolean; onChange: (color: string) => Promise<void>;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!position) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setPosition(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPosition(null); trigger.current?.focus(); } };
    const reposition = () => setPosition(null);
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    window.addEventListener('resize', reposition); document.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', reposition); document.removeEventListener('scroll', reposition, true);
    };
  }, [position]);
  function toggle() {
    if (position) { setPosition(null); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 158, rect.right - 150)), top: rect.bottom + 94 > window.innerHeight ? Math.max(8, rect.top - 90) : rect.bottom + 4 });
  }
  return <div className="project-color-picker">
    <button ref={trigger} className="project-color-trigger" style={{ color }} disabled={disabled} aria-label={`选择${name}的颜色`} aria-expanded={!!position} aria-controls={position ? menuId : undefined} title="项目颜色" onClick={toggle}><span/></button>
    {position && createPortal(<div ref={menu} id={menuId} className="project-color-options" style={position} role="group" aria-label={`${name}的项目颜色`}>
      {projectPalette.map((value, index) => <button key={value} disabled={disabled} style={{ background: value }} aria-label={`颜色 ${index + 1}`} aria-pressed={value === color} onClick={() => { setPosition(null); trigger.current?.focus(); void onChange(value).catch(() => {}); }}>{value === color ? '✓' : ''}</button>)}
    </div>, document.body)}
  </div>;
}
