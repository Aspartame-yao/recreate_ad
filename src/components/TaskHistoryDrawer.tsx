import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { TaskSummary } from '../lib/taskApi'
import { listTasks, removeTask } from '../lib/taskApi'

export function TaskHistoryDrawer({ open, currentId, onClose, onContinue }: { open: boolean; currentId?: string; onClose: () => void; onContinue: (id: string) => Promise<void> }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const refresh = async () => { setLoading(true); try { setTasks((await listTasks()).tasks) } finally { setLoading(false) } }
  useEffect(() => { if (open) refresh() }, [open])
  if (!open) return null
  const remove = async (id: string) => {
    if (!window.confirm('确认删除该历史任务及其归档媒体吗？')) return
    setWorking(id); try { await removeTask(id); await refresh() } finally { setWorking(null) }
  }
  return <div className="task-mask" onClick={e => { if (e.target === e.currentTarget) onClose() }}><aside className="task-drawer"><div className="task-drawer-head"><div><div className="task-drawer-title">历史任务</div><div className="task-drawer-note">生成视频、参考图、策略和编辑状态都会保留在任务中。</div></div><button className="pv-icon" aria-label="关闭" onClick={onClose}><X size={17} /></button></div><div className="task-list">{loading && <div className="task-empty">正在读取任务…</div>}{!loading && !tasks.length && <div className="task-empty">暂无历史任务</div>}{tasks.map(task => <article key={task.id} className={`task-card ${task.id === currentId ? 'on' : ''}`}><div className="task-card-preview">{task.preview ? <video src={task.preview} muted preload="metadata" /> : <span>任务</span>}</div><div className="task-card-body"><div className="task-card-name">{task.name}</div><div className="task-card-meta">更新于 {new Date(task.updatedAt).toLocaleString()} · {task.shots} 分镜 · 进度 {task.step + 1}/5</div><div className="task-card-actions"><button className="chip" disabled={working === task.id || task.id === currentId} onClick={async () => { setWorking(task.id); try { await onContinue(task.id); onClose() } finally { setWorking(null) } }}>{task.id === currentId ? '当前任务' : working === task.id ? '加载中…' : '继续编辑'}</button><button className="task-delete" disabled={working === task.id} onClick={() => remove(task.id)}>删除</button></div></div></article>)}</div></aside></div>
}
