import { create } from 'zustand';
import { api, errorText } from '../bridge/api';
import type { CalendarProject, PlannerSettings, Project, ScheduleEntry, ScheduleUpdate, TaskSummary } from '../generated/contracts';

export const projectPalette = ['#608e75', '#648ec4', '#b58b55', '#9477b8', '#c47876', '#599a9e', '#ae799a', '#889856'];
export function getProjectColor(projectId: string, settings: PlannerSettings) {
  const saved = settings.projectColors[projectId];
  if (saved && /^#[0-9a-f]{6}$/i.test(saved)) return saved;
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return projectPalette[hash % projectPalette.length];
}
const taskLookups = new WeakMap<TaskSummary[], { exact: Map<string, TaskSummary>; basename: Map<string, TaskSummary | undefined> }>();
export function resolveScheduledTask(entry: ScheduleEntry, tasks: TaskSummary[]) {
  let lookup = taskLookups.get(tasks);
  if (!lookup) {
    lookup = { exact: new Map(), basename: new Map() };
    for (const task of tasks) {
      lookup.exact.set(task.key, task);
      const basename = task.key.split('/').pop()!;
      lookup.basename.set(basename, lookup.basename.has(basename) ? undefined : task);
    }
    taskLookups.set(tasks, lookup);
  }
  const exact = lookup.exact.get(entry.taskKey);
  if (exact) return exact;
  return lookup.basename.get(entry.taskKey.split('/').pop()!);
}

interface PlannerState {
  settings: PlannerSettings;
  projectData: Record<string, CalendarProject>;
  loading: boolean;
  saving: boolean;
  error: string;
  settingsError: string;
}
export const usePlanner = create<PlannerState>(() => ({
  settings: { projectColors: {}, schedules: [] }, projectData: {}, loading: false, saving: false, error: '', settingsError: '',
}));
let settingsRequest: Promise<void> | undefined;
let generation = 0;
let calendarRequest: { key: string; promise: Promise<void> } | undefined;
const projectTickets = new Map<string, number>();
let saveTail: Promise<void> = Promise.resolve();
let saveCount = 0;
let settingsVersion = 0;

export function loadPlannerSettings() {
  if (settingsRequest) return settingsRequest;
  const version = settingsVersion;
  settingsRequest = api.plannerSettings().then(settings => {
    if (version === settingsVersion) usePlanner.setState({ settings, settingsError: '' });
  }).catch(error => { if (version === settingsVersion) usePlanner.setState({ settingsError: errorText(error) }); })
    .finally(() => { settingsRequest = undefined; });
  return settingsRequest;
}
export function loadCalendar(projects: Project[], force = false) {
  const key = projects.map(project => project.id).join('|');
  if (!force && calendarRequest?.key === key) return calendarRequest.promise;
  const ticket = ++generation;
  usePlanner.setState({ loading: true, error: '' });
  const promise = (async () => {
    const errors: string[] = [];
    for (const project of projects) {
      if (ticket !== generation) return;
      const projectTicket = (projectTickets.get(project.id) ?? 0) + 1;
      projectTickets.set(project.id, projectTicket);
      try {
        const data = await api.calendarProject(project.id, force);
        if (ticket !== generation) return;
        if (projectTickets.get(project.id) === projectTicket) {
          usePlanner.setState(state => ({ projectData: { ...state.projectData, [project.id]: data } }));
        }
      } catch (error) {
        if (projectTickets.get(project.id) === projectTicket) errors.push(`${project.name}：${errorText(error)}`);
      }
    }
    if (ticket === generation) usePlanner.setState({ error: errors.join('；') });
  })().finally(() => {
    if (ticket === generation) { calendarRequest = undefined; usePlanner.setState({ loading: false }); }
  });
  calendarRequest = { key, promise };
  return promise;
}
export async function refreshCalendarProject(projectId: string) {
  const ticket = (projectTickets.get(projectId) ?? 0) + 1;
  projectTickets.set(projectId, ticket);
  try {
    const data = await api.calendarProject(projectId, false);
    if (projectTickets.get(projectId) === ticket) usePlanner.setState(state => ({ projectData: { ...state.projectData, [projectId]: data } }));
  } catch (error) { if (projectTickets.get(projectId) === ticket) usePlanner.setState({ error: errorText(error) }); }
}
function save(action: () => Promise<PlannerSettings>) {
  saveCount++;
  settingsVersion++;
  usePlanner.setState({ saving: true, error: '' });
  const request = saveTail.then(action).then(settings => {
    settingsVersion++;
    usePlanner.setState({ settings });
  }).catch(error => { usePlanner.setState({ error: errorText(error) }); throw error; })
    .finally(() => { saveCount--; usePlanner.setState({ saving: saveCount > 0 }); });
  saveTail = request.catch(() => {});
  return request;
}
export const setProjectColor = (projectId: string, color: string) => save(() => api.setProjectColor(projectId, color));
export const updateSchedule = (input: ScheduleUpdate) => save(() => api.updateTaskSchedule(input));
