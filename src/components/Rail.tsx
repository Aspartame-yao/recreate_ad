import { useStore, STEPS } from '../store'
import { Captions, Clapperboard, Film, Image, ScanSearch, Plus, FolderOpen, Users } from 'lucide-react'

export function Rail({ onTasks, onSubjects, onNewTask, onNavigate }: { onTasks: () => void; onSubjects: () => void; onNewTask: () => void; onNavigate: () => void }) {
  const { state, dispatch } = useStore()
  const go = (step: number) => { onNavigate(); dispatch({ type: 'goStep', step }) }
  const icons = [ScanSearch, Clapperboard, Captions, Film, Image]
  return (
    <aside className="rail" aria-label="工作台导航"><div className="rail-in">
      <div className="rail-library">
        <button aria-label="新建创作" className="btn btn--primary rail-new" onClick={onNewTask}><Plus size={16} /><span>新建创作</span></button>
        <button className="rail-destination" aria-label="任务" onClick={onTasks}><FolderOpen size={17} /><span>任务</span></button>
        <button className="rail-destination" aria-label="主体库" onClick={onSubjects}><Users size={17} /><span>主体库</span><b>{state.subjects.length}</b></button>
      </div>
      <div className="rail-section-label">创作流程</div>
      {STEPS.map((x, i) => {
        const st = i < state.step ? 'done' : i === state.step ? 'active' : ''
        const Icon = icons[i]
        return (
          <button key={x.no} type="button" title={`${x.no} ${x.nm}`} aria-label={`${x.no} ${x.nm}`} aria-current={i === state.step ? 'step' : undefined} className={`rail-step ${st}`} onClick={() => go(i)}>
            <span className="rail-icon"><Icon size={17} strokeWidth={1.8} /></span>
            <span className="rail-copy"><span className="nm">{x.nm}</span></span>
          </button>
        )
      })}
    </div></aside>
  )
}
