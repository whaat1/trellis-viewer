import { Component, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore, initialize, activateProject, addProject, removeProject, reorderProjects, selectRoot, ensureTree, selectDocument } from '../state/store';
import { demoMode } from '../bridge/api';
import { WorkspaceLayout } from './WorkspaceLayout';
import { PerformancePanel } from '../features/performance/PerformancePanel';
import { CalendarWorkspace } from './CalendarWorkspace';
import { ProjectColorPicker } from './ProjectColorPicker';
import { WorkspaceIcon } from './WorkspaceIcon';
import { getProjectColor, loadPlannerSettings, setProjectColor, usePlanner } from '../state/planner';
import './navigation.css';
class ErrorBoundary extends Component<{children: ReactNode}, {error: string}> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="fatal"><h1>界面遇到问题</h1><pre>{this.state.error}</pre><button onClick={() => location.reload()}>重新打开</button></main> : this.props.children; }
}
function Workspace() {
  const projects = useStore(s => s.projects); const projectId = useStore(s => s.projectId); const autoBenchmark = useStore(s => s.autoBenchmark); const error = useStore(s => s.error); const diagnostics = useStore(s => s.diagnostics);
  const settings = usePlanner(state => state.settings); const saving = usePlanner(state => state.saving); const plannerError = usePlanner(state => state.error || state.settingsError);
  const [view, setView] = useState<'tasks' | 'calendar'>(() => { try { return localStorage.getItem('trellis.viewer.view') === 'calendar' ? 'calendar' : 'tasks'; } catch { return 'tasks'; } });
  const navigation = useRef(0);
  function changeView(next: 'tasks' | 'calendar') { navigation.current++; setView(next); try { localStorage.setItem('trellis.viewer.view', next); } catch { /* View works without saved preference. */ } }
  async function openTask(project: string, key: string) {
    changeView('tasks'); const ticket = navigation.current;
    const currentProject = useStore.getState();
    if (currentProject.projectId !== project || currentProject.loading || !currentProject.index) await activateProject(project);
    if (ticket !== navigation.current || useStore.getState().projectId !== project) return;
    const current = useStore.getState(); const tasks = current.index?.tasks;
    if (!tasks?.[key]) { useStore.setState({ error: '该任务暂不可用，请刷新日历后重试。' }); return; }
    const chain = [key]; const seen = new Set(chain);
    let parent = tasks[key].parentKey;
    while (parent && tasks[parent] && !seen.has(parent)) { chain.push(parent); seen.add(parent); parent = tasks[parent].parentKey; }
    useStore.setState({ filter: 'all', expanded: new Set([...current.expanded, ...chain.map(item => `task:${item}`)]) });
    const root = chain[chain.length - 1];
    selectRoot(root);
    await ensureTree(key);
    if (ticket !== navigation.current || useStore.getState().projectId !== project || useStore.getState().rootKey !== root) return;
    const document = useStore.getState().docs[key]?.[0];
    if (document) selectDocument(key, document.key);
  }
  useEffect(() => { void loadPlannerSettings(); }, []);
  useEffect(() => { let disposed = false; let cleanup: (() => void) | undefined; void initialize().then(fn => { if (disposed) fn(); else cleanup = fn; }); return () => { disposed = true; cleanup?.(); }; }, []);
  return <div className={`workspace with-navigation ${view === 'calendar' ? 'calendar-active' : ''}`}>
    <nav className="view-rail" aria-label="视图切换"><span className="rail-brand" title="Trellis Viewer"><img src="/brand/icon.svg" width="36" height="36" alt="Trellis Viewer"/></span>
      <button className={view === 'tasks' ? 'active' : ''} aria-pressed={view === 'tasks'} onClick={() => changeView('tasks')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 9 1 1 2-2m2 1h3m-8 6 1 1 2-2m2 1h3"/></svg>任务</button>
      <button className={view === 'calendar' ? 'active' : ''} aria-pressed={view === 'calendar'} onClick={() => changeView('calendar')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h1m3 0h1m3 0h1m-9 4h1m3 0h1"/></svg>日历</button>
    </nav>
    {view === 'tasks' && <aside className="projects" aria-label="项目列表"><div className="brand"><span>Trellis<small>任务阅读器</small></span></div><div className="projects-label">项目 <button className="icon-button" onClick={() => void addProject()} aria-label="添加项目"><WorkspaceIcon name="plus"/></button></div><nav className="project-list">{projects.map(item => {
      const color = getProjectColor(item.id, settings);
      return <div draggable className={`project-navigation-row ${item.id === projectId ? 'active' : ''}`} key={item.id} onDragStart={event => event.dataTransfer.setData('text/project-id', item.id)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const from = event.dataTransfer.getData('text/project-id'); if (!from || from === item.id) return; const ids = projects.map(p => p.id); const a = ids.indexOf(from), b = ids.indexOf(item.id); if (a < 0 || b < 0) return; ids.splice(a, 1); ids.splice(b, 0, from); void reorderProjects(ids); }}>
        <button className={`project-item ${item.id === projectId ? 'active' : ''}`} style={{ '--project-color': color } as CSSProperties} onClick={() => { navigation.current++; void activateProject(item.id); }} title={item.path}><span className="project-symbol" style={{ color }}>{item.name.slice(0, 1).toUpperCase()}</span><span>{item.name}</span></button>
        <ProjectColorPicker name={item.name} color={color} disabled={saving} onChange={value => setProjectColor(item.id, value)}/>
        <button aria-label={`移除项目 ${item.name}`} onClick={() => void removeProject(item.id)}>×</button>
      </div>;
    })}</nav><button className="add-project" onClick={() => void addProject()}><WorkspaceIcon name="plus"/>添加本地项目</button><div className="project-bottom">{demoMode && <strong className="demo-label">浏览器演示 · 合成数据</strong>}</div></aside>}
    <main className="main-workspace">
      {autoBenchmark && <PerformancePanel/>}
      {error && <div className="error" role="alert">{error}<button onClick={() => useStore.setState({error:''})} aria-label="关闭错误">×</button></div>}
      {view === 'tasks' && !!diagnostics.length && <details className="diagnostics"><summary>{diagnostics.length} 条数据提示</summary>{diagnostics.slice(0, 20).map((message, i) => <div key={i}>{message}</div>)}</details>}
      {view === 'tasks' && plannerError && <div className="error" role="alert">{plannerError}<button aria-label="关闭设置提示" onClick={() => usePlanner.setState({ error: '', settingsError: '' })}>×</button></div>}
      {view === 'calendar' ? <CalendarWorkspace projects={projects} onOpenTask={(project, key) => { void openTask(project, key); }}/> : !projectId ? <div className="welcome"><span className="empty-glyph">▧</span><h1>把项目放进来，清晰地读任务。</h1><p>添加一个包含 .trellis 的本地项目。<br/>任务、文档与父子关系，会在这里自动整理。</p><button className="primary" onClick={() => void addProject()}>添加项目</button></div> : <WorkspaceLayout/>}
    </main>
  </div>;
}
export function App() { return <ErrorBoundary><Workspace/></ErrorBoundary>; }
