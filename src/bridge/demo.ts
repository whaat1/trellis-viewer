import type { Project, TaskSummary, Snapshot, DocEntry, Document as TaskDocument, PlannerSettings, ScheduleUpdate } from '../generated/contracts';
import { validRange } from '../features/calendar/model';
const project: Project = { id: 'explicit-browser-demo', name: '客户服务系统 · 演示', path: '/explicit-demo/trellis' };
const tasks: TaskSummary[] = Array.from({ length: 2000 }, (_, i) => {
  const parent = Math.floor(i / 5) * 5;
  const key = `09-11-task-${String(i).padStart(5, '0')}`;
  return { key, title: i === 0 ? '客户服务系统' : ['需求与交互设计', '数据接口与联调', '服务监控与日志', '验收与发布', '客户工作台'][i % 5] + ` ${i}`, status: ['in_progress', 'planning', 'review', 'completed'][Math.floor(i / 5) % 4], relativeDir: key, parentKey: i % 5 ? `09-11-task-${String(parent).padStart(5, '0')}` : null, childKeys: i % 5 ? [] : [1, 2, 3, 4].map(n => `09-11-task-${String(i + n).padStart(5, '0')}`), archived: i >= 500, revision: 'demo-1' };
});
const snapshot: Snapshot = { projectId: project.id, epoch: 'demo', revision: 1, tasks, rootKeys: tasks.filter(task => !task.parentKey).map(task => task.key), scanMs: 0, diagnostics: [] };
const secondProject: Project = { id: 'calendar-browser-demo', name: '产品改版 · 演示', path: '/explicit-demo/product' };
const secondTasks = tasks.slice(0, 10).map((task, i) => ({ ...task, title: ['产品改版', '梳理用户流程', '绘制原型', '接口联调', '验收新版本'][i % 5] + (i >= 5 ? ' · 第二阶段' : ''), archived: false, status: i === 2 || i === 4 ? 'completed' : i < 5 ? 'in_progress' : 'planning' }));
secondTasks.push({ key: '09-12-independent', relativeDir: '09-12-independent', title: '发布检查', parentKey: null, childKeys: [], status: 'planning', archived: false, revision: 'demo-1' });
const demoProjects = [project, secondProject];
const demoDate = (offset: number) => {
  const date = new Date(); date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
let plannerSettings: PlannerSettings = {
  projectColors: { [project.id]: '#648ec4', [secondProject.id]: '#b58b55' },
  schedules: [
    { id: 'demo-schedule-1', projectId: project.id, taskKey: tasks[0].key, title: tasks[0].title, startDate: demoDate(-1), endDate: demoDate(1) },
    { id: 'demo-schedule-2', projectId: secondProject.id, taskKey: secondTasks[0].key, title: secondTasks[0].title, startDate: demoDate(1), endDate: demoDate(3) },
  ],
};
try {
  const saved = JSON.parse(localStorage.getItem('trellis.demo.planner.v1') || 'null') as PlannerSettings | null;
  if (saved && saved.projectColors && Array.isArray(saved.schedules)) plannerSettings = saved;
} catch { /* Explicit demo can start without persisted sample settings. */ }
function persistPlanner(next: PlannerSettings) {
  localStorage.setItem('trellis.demo.planner.v1', JSON.stringify(next));
  plannerSettings = next;
  return structuredClone(next);
}
const paths = ['prd.md', 'design.md', 'baseline-64k.md', 'long-paragraphs.md', 'long-table.md', 'long-code.md', 'images.md', 'research/nested/notes.md'];
const docs: DocEntry[] = paths.map(path => ({ key: path, path, name: path.split('/').pop()! }));
function content(key: string, projectId: unknown) {
  if (key === 'long-paragraphs.md') return '# 长文档压力演示\n\n' + Array.from({length:1500}, (_, i) => `## 第 ${i + 1} 节\n\n` + '任务的进展与上下文保存在项目中。阅读器只展示已有信息，帮助你聚焦当前工作。'.repeat(15) + '\n\n').join('');
  if (key === 'long-code.md') return '# 代码压力文档\n\n```typescript\n' + 'const task = { title: "客户服务系统", status: "in_progress" };\n'.repeat(18000) + '\n```';
  if (key === 'long-table.md') return '# 表格压力文档\n\n| 编号 | 任务 | 状态 |\n|---|---|---|\n' + Array.from({length:12000}, (_, i) => `| ${i} | 服务系统工作项 | 进行中 |\n`).join('');
  if (key === 'baseline-64k.md') return '# 常规文档\n\n' + '这是用于文档阅读性能测试的常规段落。\n\n'.repeat(1200);
  if (key === 'images.md') return '# 图片\n\n![架构示意](assets/architecture.png)';
  return '# 客户服务系统\n\n> 把分散的服务任务放在一起，让项目进展更清晰。\n\n## 项目目标\n\n建立统一的客户服务工作台，支持任务协作、服务跟踪与文档沉淀。\n\n## 本轮工作\n\n- [x] 明确产品方向与三栏布局\n- [x] 梳理父任务、子任务与文档关系\n- [ ] 接通真实项目数据\n- [ ] 验证大量任务下的滚动流畅度\n\n## 设计原则\n\n**阅读优先。** 任务状态通过上方 Tab 切换，相关文档保留原始目录层级。\n\n| 栏目 | 用途 |\n| --- | --- |\n| 项目栏 | 切换本地项目 |\n| 任务目录 | 阅读父任务与子任务文档 |\n| 文档区 | 专注查看 Markdown 内容 |\n\n## 下一步\n\n点击上方任务卡切换工作上下文，或者展开左侧的 `research` 文件夹。\n\n```typescript\nconst principles = ["只读", "流畅", "清晰"];\n```\n\n[查看技术设计](design.md)'.replaceAll('客户服务系统', projectId === secondProject.id ? '产品改版' : '客户服务系统');
}
export async function demoInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  let result: unknown;
  switch (command) {
    case 'get_bootstrap': result = { epoch: 'demo', projects: demoProjects, autoBenchmark: false, autoBenchmarkRepeats: 1, autoBenchmarkSeconds: 60 }; break;
    case 'choose_and_add_project': result = project; break;
    case 'activate_project': case 'get_project_snapshot': result = args.projectId === secondProject.id ? { ...snapshot, projectId: secondProject.id, tasks: secondTasks, rootKeys: secondTasks.filter(task => !task.parentKey).map(task => task.key) } : snapshot; break;
    case 'get_project_changes': result = { projectId: project.id, epoch: 'demo', baseRevision: 1, revision: 1, resetRequired: false, upserts: [], removed: [], rootKeys: null, documentTaskKeys: [], diagnostics: [] }; break;
    case 'get_document_tree': result = docs; break;
    case 'read_document': result = { taskKey: String(args.taskKey), key: String(args.documentKey), content: content(String(args.documentKey), args.projectId), revision: 'demo-1', readMs: 0 } satisfies TaskDocument; break;
    case 'get_planner_settings': result = structuredClone(plannerSettings); break;
    case 'get_calendar_project': result = { projectId: args.projectId, tasks: args.projectId === secondProject.id ? secondTasks : tasks, diagnostics: [] }; break;
    case 'set_project_color': {
      const color = String(args.color);
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('颜色格式无效');
      if (!demoProjects.some(project => project.id === args.projectId)) throw new Error('项目暂不可用');
      result = persistPlanner({ ...plannerSettings, projectColors: { ...plannerSettings.projectColors, [String(args.projectId)]: color } }); break;
    }
    case 'update_task_schedule': {
      const input = args.input as ScheduleUpdate;
      const existing = plannerSettings.schedules.find(entry => input.id ? entry.id === input.id : entry.projectId === input.projectId && entry.taskKey === input.taskKey);
      if (input.id && !existing) throw new Error('排期不存在');
      if (existing && existing.projectId !== input.projectId) throw new Error('排期属于其他项目');
      const clearing = input.startDate === null && input.endDate === null;
      if (!(clearing && input.id) && !demoProjects.some(project => project.id === input.projectId)) throw new Error('项目暂不可用');
      const source = (input.projectId === secondProject.id ? secondTasks : tasks).find(task => task.key === input.taskKey);
      const remaining = plannerSettings.schedules.filter(entry => entry.id !== existing?.id);
      if (!clearing) {
        if (!input.startDate || !input.endDate || !validRange(input.startDate, input.endDate) || !source || source.parentKey !== null || source.status === 'cancelled') throw new Error('请选择有效的父任务或独立任务及起止日期');
        if (existing && existing.taskKey !== input.taskKey) throw new Error('排期无法关联到该任务');
        if (remaining.some(entry => entry.projectId === input.projectId && entry.taskKey === input.taskKey)) throw new Error('任务已有其他排期');
        remaining.push({ id: existing?.id ?? crypto.randomUUID(), projectId: input.projectId, taskKey: input.taskKey, title: source.title, startDate: input.startDate, endDate: input.endDate });
      }
      result = persistPlanner({ ...plannerSettings, schedules: remaining }); break;
    }
    case 'save_perf_report': result = '浏览器演示结果仅保留在内存，不是桌面性能证据'; break;
    default: throw new Error(`Unsupported demo command: ${command}`);
  }
  return result as T;
}
