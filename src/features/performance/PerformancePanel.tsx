import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { errorText } from '../../bridge/api';
import { performanceState, runBenchmark, type Summary, type ProjectReport } from './benchmark';
function pair(summary: Summary) { return summary.count ? `${summary.p95.toFixed(1)} / ${summary.p99.toFixed(1)} ms` : '未采样'; }
function maximum(summary: Summary) { return summary.count ? `${summary.max.toFixed(1)} ms` : '未采样'; }
function ProjectResults({ report }: { report: ProjectReport }) {
  const completed = report.documentCases.filter(item => item.status === 'rendered').length;
  const failed = report.documentCases.filter(item => item.status !== 'rendered');
  const baseline = report.baseline64kReadyMs;
  return <div><h3>{report.projectName} · {report.taskCount} 个任务</h3>
    <table className="perf-results"><tbody>
      <tr><td>程序化反馈 P95 / P99</td><td>{pair(report.dispatchToFrameMs)}</td></tr>
      <tr><td>前台帧间隔 P95 / P99</td><td>{pair(report.foregroundFrameGapMs)}</td></tr>
      <tr><td>64KiB 可读 P95</td><td>{baseline.count ? `${baseline.p95.toFixed(1)} ms（${baseline.count}/20 次完成${baseline.count < 20 ? '，采样不完整' : ''}）` : '未采样：无有效正文样本'}</td></tr>
      <tr><td>文档场景</td><td>{report.documentCases.length ? `${completed}/${report.documentCases.length} 已完成` : '未采样：缺少测试文档'}</td></tr>
      <tr><td>文档阶段最大帧间隔</td><td>{maximum(report.documentFrameGapMs)}</td></tr>
      <tr><td>最大滚动帧间隔</td><td>{maximum(report.foregroundFrameGapMs)}</td></tr>
      <tr><td>更新后阅读位置</td><td>{report.refreshPreservation.status === 'passed' ? '保持稳定' : report.refreshPreservation.status === 'failed' ? '未保持，请查看报告' : '未验证：未观察到有效更新'}</td></tr>
      <tr><td>收到增量 / 文档失效</td><td>{report.counters.patchCount} / {report.counters.documentInvalidations}</td></tr>
      <tr><td>最多挂载卡片 / 正文块</td><td>{report.mountedTaskCardsMax} / {report.mountedMarkdownBlocksMax}</td></tr>
    </tbody></table>
    {failed.length > 0 && <div className="error" role="alert">文档测试未完成：{failed.map(item => `${item.key}（超时或未就绪）`).join('、')}</div>}
    {report.documentCases.length > 0 && <ul>{report.documentCases.map(item => <li key={item.key}>{item.key}：{item.readyMs === null ? '读取超时／未完成' : `${item.readyMs.toFixed(1)} ms 可读`}</li>)}</ul>}
  </div>;
}
let autorunStarted = false;
export function PerformancePanel() {
  const repeats = useStore(s => s.autoBenchmarkRepeats); const autoSeconds = useStore(s => s.autoBenchmarkSeconds);
  const auto = useStore(s => s.autoBenchmark); const ready = useStore(s => !!s.index && !s.loading);
  const [open, setOpen] = useState(false); const [seconds, setSeconds] = useState(20); const [state, setState] = useState(performanceState.snapshot); const [error, setError] = useState('');
  useEffect(() => performanceState.subscribe(() => setState(performanceState.snapshot())), []);
  useEffect(() => {
    if (!auto || !ready || autorunStarted) return;
    autorunStarted = true; setOpen(true);
    let stopped = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (let run = 0; run < repeats && !stopped; run++) {
          const report = await runBenchmark({ scrollSeconds: autoSeconds, allProjects: false, requestFocus: run === 0 });
          if (report.status !== 'completed') break;
        }
      })().catch(reason => setError(errorText(reason)));
    }, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [auto, ready, repeats, autoSeconds]);
  async function run() { setError(''); try { await runBenchmark({ scrollSeconds: seconds, selections: 100 }); } catch (reason) { setError(errorText(reason)); } }
  return <><button className="perf-button" onClick={() => setOpen(value => !value)}>◴ {state.running ? '正在采样' : '性能测试'}</button>{open && <aside className="perf-panel" aria-label="性能测试"><header><h2>流畅度验证</h2><button onClick={() => setOpen(false)} aria-label="关闭性能面板">×</button></header><p>读取当前项目的真实文件，完成 100 次程序化任务／筛选操作，再持续滚动。采样时请保持窗口在前台。</p><p>程序化操作至帧回调的耗时，不等于真实鼠标输入延迟；rAF 也不能单独证明绘制帧率。</p><label>滚动时间（秒）<input type="number" min="3" max="120" value={seconds} onChange={event => setSeconds(Number(event.target.value))} disabled={state.running}/></label><button className="primary" disabled={state.running || !ready} onClick={() => void run()}>{state.running ? '采样中…' : '开始采样'}</button><div className="perf-progress" role="status">{state.progress}</div>{error && <div className="error">{error}</div>}{state.latest?.status === 'aborted' && <div className="error" role="alert">采样已中止，结果无效：{state.latest.error}</div>}{state.latest?.projects.map(report => <ProjectResults key={report.projectId} report={report} />)}{state.latest?.path && <pre>{state.latest.path}</pre>}</aside>}</>;
}
