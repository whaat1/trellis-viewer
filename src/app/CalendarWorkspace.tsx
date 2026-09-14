import { lazy, Suspense, useEffect, useRef } from 'react';
import type { Project } from '../generated/contracts';
import { useStore } from '../state/store';
import { usePlanner, loadCalendar, refreshCalendarProject, setProjectColor, updateSchedule } from '../state/planner';

const CalendarView = lazy(() => import('../features/calendar/CalendarView').then(module => ({ default: module.CalendarView })));
export function CalendarWorkspace({ projects, onOpenTask }: { projects: Project[]; onOpenTask: (projectId: string, taskKey: string) => void }) {
  const planner = usePlanner();
  const activeIndex = useStore(state => state.index);
  const previousIndex = useRef(activeIndex);
  useEffect(() => {
    void loadCalendar(projects);
    let lastFocus = Date.now();
    const refresh = () => {
      if (Date.now() - lastFocus < 30_000) return;
      lastFocus = Date.now(); void loadCalendar(projects);
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [projects]);
  useEffect(() => {
    const previous = previousIndex.current;
    previousIndex.current = activeIndex;
    if (activeIndex && previous?.projectId === activeIndex.projectId && previous.tasks !== activeIndex.tasks) {
      void refreshCalendarProject(activeIndex.projectId);
    }
  }, [activeIndex]);
  return <Suspense fallback={<div className="calendar-loading">正在打开月历…</div>}>
    <CalendarView projects={projects} projectData={planner.projectData} settings={planner.settings}
      loading={planner.loading} saving={planner.saving} error={planner.error || planner.settingsError}
      onRefresh={() => { void loadCalendar(projects, true); }} onSchedule={updateSchedule}
      onColor={setProjectColor} onOpenTask={onOpenTask}/>
  </Suspense>;
}
