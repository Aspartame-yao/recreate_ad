import { useEffect, useRef } from 'react'
import { useStore, useToast } from '../store'
import { splitVideoSegments } from '../lib/museApi'

export function ShotSplitControl({ variant = 'summary', auto = false, silent = false }: { variant?: 'summary' | 'workflow'; auto?: boolean; silent?: boolean }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const total = state.shots.length
  const done = state.shots.filter(s => s.splitStatus === 'done' && s.shotTrimmedId).length
  const failed = state.shots.filter(s => s.splitStatus === 'failed').length
  const allSplit = total > 0 && done === total

  async function runSplit() {
    if (!state.source.trimmedId) { toast('请先在 1.0 完成视频裁剪', { tone: 'warn' }); return }
    if (!total) { toast('请先在 1.0 完成整片反推', { tone: 'warn' }); return }
    const snapshot = state.shots.map(sh => ({ id: sh.id, start: sh.sourceStart, end: sh.sourceEnd }))
    dispatch({ type: 'startSplit' })
    try {
      const r = await splitVideoSegments({ source_id: state.source.trimmedId, segments: snapshot.map(({ start, end }) => ({ start, end })) })
      const results = snapshot.map((sh, i) => {
        const hit = r.results?.[i]
        return {
          id: sh.id,
          ok: !!(hit?.ok && hit.shot_trimmed_id),
          shotTrimmedId: hit?.shot_trimmed_id,
          error: hit?.error,
        }
      })
      dispatch({ type: 'completeSplit', results })
      const okCount = results.filter(x => x.ok).length
      toast(`分镜拆分完成 · ${okCount}/${total} 段成功`, okCount < total ? { tone: 'warn' } : undefined)
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 160)
      dispatch({ type: 'failSplit', err })
      toast('分镜拆分失败：' + err, { tone: 'warn' })
    }
  }

  const autoStarted = useRef(false)
  useEffect(() => {
    if (!auto || autoStarted.current || !total || !state.source.trimmedId || state.splitting || allSplit) return
    autoStarted.current = true
    runSplit()
    // Only once per mounted strategy report. Subsequent status changes are handled by reducer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, total, state.source.trimmedId, state.splitting, allSplit])

  const text = state.splitting
    ? '拆分中…'
    : allSplit
      ? `已完成 ${done}/${total}`
      : failed
        ? `成功 ${done} · 失败 ${failed}`
        : total
          ? `待拆分 ${total} 段`
          : '等待整片反推'

  if (silent) return null

  return (
    <div className={`split-control split-control--${variant}`}>
      <div className="split-control__top">
        <div>
          <div className="split-control__title">{variant === 'summary' ? '拆镜任务确认' : '分镜原片拆分'}</div>
          <div className="split-control__note">
            {variant === 'workflow'
              ? '按 1.0 产出的时间轴，把裁剪参考片切成可独立反推的原片小视频。'
              : `已识别 ${total} 个生成任务 · ${state.strategySkill?.meta?.total_duration_s || 0} 秒参考片`}
          </div>
        </div>
        <div className="split-control__actions">
          <span className={`st-chip ${allSplit ? 'st-done' : failed ? 'st-fail' : state.splitting ? 'st-run' : ''}`}><span className="st-dot" />{text}</span>
          <button className="btn btn--primary" onClick={runSplit} disabled={state.splitting || !total || !state.source.trimmedId}>
            {state.splitting ? '拆分中…' : done || failed ? '↻ 重新拆分' : '确认并拆分 →'}
          </button>
        </div>
      </div>
      {variant === 'summary' && total > 0 && <div className="split-task-strip">{state.shots.map((shot, i) => <div key={shot.id} className={`split-task-card split-task-card--${i % 5}`}><span>{String(i + 1).padStart(2, '0')}</span><strong>{shot.no}</strong><em>{shot.range}</em><i>{shot.duration.toFixed(1)}s · {shot.role}</i></div>)}</div>}
    </div>
  )
}
