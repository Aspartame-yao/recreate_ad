import { useEffect, useRef, useState, Component, type ReactNode } from 'react'
import { StoreProvider, useStore, runToastUndo } from './store'
import { Nav } from './components/Nav'
import { Rail } from './components/Rail'
import { Stage } from './components/Stage'
import { Palette } from './components/Palette'
import { TaskHistoryDrawer } from './components/TaskHistoryDrawer'
import { createTask, getTask, listTasks, saveTask } from './lib/taskApi'
import { initialState } from './store'
import { Mountain } from 'lucide-react'

// 兜底：任一步骤渲染抛错时显示错误信息而非整页白屏（此前进策略分析白屏无任何提示）
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: unknown) { console.error('[Stage crashed]', error, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 720, margin: '80px auto', padding: '0 24px', fontFamily: 'var(--font-body)' }}>
          <div style={{ fontSize: 13, letterSpacing: '.08em', color: 'var(--color-accent)', marginBottom: 12 }}>RENDER ERROR</div>
          <h2 style={{ fontWeight: 300, fontSize: 28, margin: '0 0 12px', color: 'var(--color-ink)' }}>这一步出错了</h2>
          <p style={{ color: 'var(--color-ink-2)', lineHeight: 1.7, marginBottom: 20 }}>页面渲染时抛出异常，已阻止白屏。可刷新重试；若持续，请把下方信息反馈。</p>
          <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-ink-3)', background: 'var(--color-surface-2, #f4f4f2)', padding: 14, borderRadius: 8, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{String(this.state.error?.stack || this.state.error?.message || this.state.error)}</pre>
          <button className="btn btn--primary" style={{ marginTop: 18 }} onClick={() => this.setState({ error: null })}>重试渲染</button>
        </div>
      )
    }
    return this.props.children
  }
}

function Shell() {
  const { state, dispatch } = useStore()
  const [palOpen, setPalOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const booted = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const boot = async () => {
      try {
        const tasks = (await listTasks()).tasks
        if (tasks.length) {
          const task = await getTask(tasks[0].id)
          dispatch({ type: 'hydrateTask', state: task.snapshot, taskId: task.id, taskName: task.name })
        } else {
          const task = await createTask('未命名任务', initialState)
          dispatch({ type: 'hydrateTask', state: task.snapshot, taskId: task.id, taskName: task.name })
        }
      } catch (e) { console.error('[task bootstrap]', e) }
      finally { booted.current = true }
    }
    boot()
  }, [dispatch])

  useEffect(() => {
    if (!booted.current || !state.taskId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { saveTask(state.taskId!, state.taskName, state).catch(e => console.warn('[task save]', e)) }, 700)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [state])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPalOpen(o => !o) }
      if (e.key === 'Escape') { setPalOpen(false); setHistoryOpen(false) }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  const createNew = async () => {
    const name = window.prompt('输入新任务名称', '未命名任务')?.trim()
    if (name === undefined) return
    const task = await createTask(name || '未命名任务', initialState)
    dispatch({ type: 'hydrateTask', state: task.snapshot, taskId: task.id, taskName: task.name })
  }
  const continueTask = async (id: string) => {
    const task = await getTask(id)
    dispatch({ type: 'hydrateTask', state: task.snapshot, taskId: task.id, taskName: task.name })
  }

  const t = state.toast
  return (
    <div className="app">
      <Nav onCmdK={() => setPalOpen(true)} onTasks={() => setHistoryOpen(true)} onNewTask={createNew} />
      <Rail />
      <ErrorBoundary><Stage /></ErrorBoundary>
      <Palette open={palOpen} onClose={() => setPalOpen(false)} />
      <TaskHistoryDrawer open={historyOpen} currentId={state.taskId} onClose={() => setHistoryOpen(false)} onContinue={continueTask} />
      {t && (
        <div className={`toast toast--${t.tone ?? 'info'}`} role="status" aria-live="polite">
          <span className="toast__msg">{t.msg}</span>
          {t.undoId && <button type="button" className="toast__undo" onClick={() => { runToastUndo(t.undoId!); dispatch({ type: 'toast', toast: null }) }}>撤销</button>}
        </div>
      )}
    </div>
  )
}

const welcomeDemos = [
  { src: './demo-food.gif', title: '食品种草', caption: '真人开场 · 产品特写 · 食欲镜头' },
  { src: './demo-fashion.gif', title: '服饰带货', caption: '痛点对比 · 面料展示 · 上身效果' },
  { src: './demo-animation.gif', title: '创意动画', caption: '角色叙事 · 冲突转折 · 视觉记忆' },
]

export default function App() {
  const [started, setStarted] = useState(false)
  const [demoIndex, setDemoIndex] = useState(0)
  const demo = welcomeDemos[demoIndex]
  const switchDemo = (direction: number) => setDemoIndex(current => (current + direction + welcomeDemos.length) % welcomeDemos.length)

  if (!started) {
    return (
      <main className="welcome">
        <nav className="welcome__nav" aria-label="欢迎页导航">
          <a className="welcome__brand" href="#top" aria-label="他山之石首页">
            <span className="welcome__brand-mark"><Mountain size={17} strokeWidth={2.1} /></span>
            <span>他山之石</span>
          </a>
          <button className="welcome__nav-cta" type="button" onClick={() => setStarted(true)}>进入工作台</button>
        </nav>

        <section className="welcome__hero" id="top">
          <div className="welcome__visual" aria-label="爆款视频复刻演示">
            <div className="welcome__gallery-head">
              <span>SELECT A DEMO</span>
              <b>点击卡片切换</b>
            </div>
            <div className="welcome__card-stage">
              {welcomeDemos.map((item, index) => {
                const position = (index - demoIndex + welcomeDemos.length) % welcomeDemos.length
                const positionClass = position === 0 ? 'is-active' : position === 1 ? 'is-next' : 'is-prev'
                return (
                  <button
                    className={`welcome__gallery-card ${positionClass}`}
                    type="button"
                    key={item.src}
                    onClick={() => setDemoIndex(index)}
                    aria-label={`查看${item.title}演示`}
                    aria-pressed={index === demoIndex}
                  >
                    <img src={item.src} alt={`${item.title}视频拆解与复刻演示`} />
                    <span className="welcome__gallery-live">● LIVE · 15S</span>
                    <span className="welcome__gallery-meta"><b>0{index + 1}</b><strong>{item.title}</strong><small>{item.caption}</small></span>
                  </button>
                )
              })}
              <div className="welcome__gallery-arrows">
                <button type="button" onClick={() => switchDemo(-1)} aria-label="上一个演示">←</button>
                <button type="button" onClick={() => switchDemo(1)} aria-label="下一个演示">→</button>
              </div>
            </div>
            <div className="welcome__gallery-dots" aria-label="演示进度">
              {welcomeDemos.map((item, index) => <button key={item.src} type="button" className={index === demoIndex ? 'is-active' : ''} onClick={() => setDemoIndex(index)} aria-label={`切换到${item.title}`} />)}
              <span>0{demoIndex + 1} / 03 · {demo.title}</span>
            </div>
          </div>

          <div className="welcome__copy">
            <div className="welcome__eyebrow"><span /> 复刻任意视频</div>
            <h1>看到同行广告爆了？<em>五分钟复刻同款。</em></h1>
            <p className="welcome__lead">上传任意参考视频，他山之石会逐帧拆解钩子、节奏、文案和画面风格，再把爆款逻辑变成你的创作方案。</p>
            <ul className="welcome__points">
              <li><b>逐帧拆解</b><span>看懂钩子、节奏与镜头构成</span></li>
              <li><b>只学方法</b><span>保留你的产品、人物和品牌表达</span></li>
              <li><b>全链路生成</b><span>从分析、复刻到成片一次完成</span></li>
            </ul>
            <div className="welcome__actions">
              <button className="welcome__primary" type="button" onClick={() => setStarted(true)}>
                快速开始 <span>→</span>
              </button>
              <span className="welcome__note">无需配置 · 立即进入工作台</span>
            </div>
          </div>
        </section>

        <footer className="welcome__footer">
          <span>01 上传参考</span><i />
          <span>02 AI 拆解</span><i />
          <span>03 复刻成片</span>
        </footer>
      </main>
    )
  }

  return <StoreProvider><Shell /></StoreProvider>
}
