import { useStore, STEPS } from '../store'
import { ArrowRight, Command, Download, FolderOpen, LogOut, Mountain, Plus, Users } from 'lucide-react'

export function Nav({ onCmdK, onTasks, onSubjects, onNewTask, onLogout, username }: { onCmdK: () => void; onTasks: () => void; onSubjects: () => void; onNewTask: () => void; onLogout: () => void; username: string }) {
  const { state, dispatch } = useStore()
  const s = STEPS[state.step]
  const nextStep = Math.min(state.step + 1, STEPS.length - 1)
  const isLastStep = state.step === STEPS.length - 1
  const renameTask = () => {
    const nextName = window.prompt('修改任务名称', state.taskName || '未命名任务')
    if (nextName?.trim()) dispatch({ type: 'setTaskName', name: nextName.trim() })
  }
  const goNext = () => {
    if (isLastStep) { window.dispatchEvent(new Event('toushi:export')); return }
    dispatch({ type: 'goStep', step: nextStep })
  }
  return (
    <nav className="nav"><div className="nav-in">
      <div className="brand">
        <div className="mark" aria-hidden><Mountain size={17} strokeWidth={2} /></div>
        <span className="wordmark">他山之石</span>
        <span className="nav-cur">广告创作工作台</span>
      </div>
      <button className="nav-project" title="点击修改任务名称" onClick={renameTask}>{state.taskName || '未命名任务'}</button>
      <div className="nav-right">
        <button className="nav-task" onClick={onNewTask}><Plus size={14} />新建任务</button>
        <button className="nav-task" onClick={onSubjects}><Users size={14} />主体库{state.subjects.length ? <b className="nav-count">{state.subjects.length}</b> : null}</button>
        <button className="nav-task" onClick={onTasks}><FolderOpen size={14} />任务库</button>
        <button className="nav-task nav-account" title={`${username} · 退出登录`} aria-label="退出登录" onClick={onLogout}><LogOut size={14} /><span>{username}</span></button>
        <button className="cmdk" onClick={onCmdK}><Command size={14} /><span>快捷操作</span><span className="k">⌘K</span></button>
        <button className="btn btn--primary nav-next" onClick={goNext}>{isLastStep ? <><Download size={15} />导出作品</> : <>下一步 · {STEPS[nextStep].nm}<ArrowRight size={15} /></>}</button>
      </div>
    </div></nav>
  )
}
