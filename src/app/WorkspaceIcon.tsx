type IconName = 'file' | 'folder' | 'task' | 'chevron-right' | 'chevron-down' | 'plus' | 'grid';

/** Fixed view boxes keep small navigation icons aligned across system fonts. */
export function WorkspaceIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="workspace-icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'file' && <><path d="M11.5 2.5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M11.5 2.5v5h5M6.5 11h7M6.5 14h5"/></>}
    {name === 'folder' && <path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4L10 6h6A1.5 1.5 0 0 1 17.5 7.5v8A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5z"/>}
    {name === 'task' && <><rect x="3" y="2.5" width="14" height="15" rx="2"/><path d="m6 7 1 1 2-2M11 7h3m-8 6 1 1 2-2M11 13h3"/></>}
    {name === 'chevron-right' && <path d="m8 5 5 5-5 5"/>}
    {name === 'chevron-down' && <path d="m5 8 5 5 5-5"/>}
    {name === 'plus' && <path d="M10 4v12M4 10h12"/>}
    {name === 'grid' && <><rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="11.5" y="2.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><rect x="11.5" y="11.5" width="6" height="6" rx="1"/></>}
  </svg>;
}
