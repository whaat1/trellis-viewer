import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../generated/contracts';
import { api, errorText } from '../bridge/api';
import { removeProject, useStore } from '../state/store';
import './project-context-menu.css';

export function ProjectContextMenu({ project, className, children }: {
  project: Project; className: string; children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [failure, setFailure] = useState('');
  const focusRow = () => row.current?.querySelector<HTMLButtonElement>('.project-item')?.focus();
  const closeMenu = () => { setPosition(null); focusRow(); };

  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    // 按实际尺寸避让窗口边缘，缩放或较小窗口也不裁切菜单。
    const bounds = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(position.left, window.innerWidth - bounds.width - 8))}px`;
    menu.current.style.top = `${Math.max(8, Math.min(position.top, window.innerHeight - bounds.height - 8))}px`;
    menu.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setPosition(null);
    };
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [position]);
  useEffect(() => {
    if (!confirming) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [confirming]);

  async function action(kind: 'reveal' | 'copy') {
    closeMenu();
    try {
      if (kind === 'reveal') await api.revealProject(project.id);
      else await api.copyProjectPath(project.id);
    } catch (error) { useStore.setState({ error: errorText(error) }); }
  }
  async function confirmRemove() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setFailure('');
    try {
      await removeProject(project.id);
      // 行已卸载，焦点转交给剩余当前项目或添加按钮，不返回失效 DOM。
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.project-item.active, .add-project')?.focus());
    } catch (error) { setFailure(errorText(error)); }
    finally { submitting.current = false; setBusy(false); }
  }
  function cancel() { if (!submitting.current) { setConfirming(false); focusRow(); } }

  return <div ref={row} className={className} onContextMenu={event => {
    event.preventDefault();
    if (!confirming) setPosition({ left: event.clientX, top: event.clientY });
  }} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = row.current!.getBoundingClientRect();
      setPosition({ left: rect.left, top: rect.bottom });
    }
  }}>
    {children}
    {position && createPortal(<div ref={menu} className="project-context-menu" style={position} role="menu" aria-label={`${project.name}的操作`} onKeyDown={event => {
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
      <button role="menuitem" className="project-remove-action" onClick={() => { setPosition(null); setFailure(''); setConfirming(true); }}>从列表移除</button>
      <button role="menuitem" onClick={() => void action('reveal')}>在 Finder 中显示</button>
      <button role="menuitem" onClick={() => void action('copy')}>复制路径</button>
    </div>, document.body)}
    {confirming && createPortal(<dialog ref={dialog} className="project-remove-dialog" aria-labelledby={`remove-title-${project.id}`} aria-describedby={`remove-description-${project.id}`} onCancel={event => { event.preventDefault(); cancel(); }}>
      <h2 id={`remove-title-${project.id}`}>移除项目“{project.name}”？</h2>
      <p id={`remove-description-${project.id}`}>这只会从应用中移除该项目。你电脑上的文件和现有聊天不会被删除。</p>
      {failure && <p role="alert" className="project-remove-error">{failure}</p>}
      <div className="project-remove-buttons">
        <button autoFocus disabled={busy} onClick={cancel}>取消</button>
        <button className="project-remove-confirm" disabled={busy} onClick={() => void confirmRemove()}>{busy ? '正在移除…' : '移除'}</button>
      </div>
    </dialog>, document.body)}
  </div>;
}
