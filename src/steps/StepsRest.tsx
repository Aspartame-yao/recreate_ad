import { useState, useRef, useEffect } from 'react'
import { useStore, useToast } from '../store'
import type { AudioClip } from '../types'
import { eraseSubtitleAndWait, exportDeliveryPackage, generateImage, generateTitles, renderComposition } from '../lib/museApi'
import { extractJson } from '../lib/parseJson'
import { CheckCircle2, Download, Sparkles, X } from 'lucide-react'

const uid = () => Math.random().toString(36).slice(2, 9)

/* ---- 3.0 视频处理：原料视频与处理结果分区展示 ---- */
export function Step3Process() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const shots = state.shots
  const targets = shots.filter(s => s.eraseOn && s.videoUrl)
  const processed = shots.filter(s => s.processedVideoUrl)
  const [busy, setBusy] = useState<Record<string, number>>({})

  const eraseOne = async (id: string) => {
    const sh = shots.find(x => x.id === id)
    if (!sh?.videoUrl) { toast('该分镜还没有可处理的复刻视频', { tone: 'warn' }); return }
    setBusy(b => ({ ...b, [id]: 1 }))
    dispatch({ type: 'setProcessError', id })
    try {
      let tick = 0
      const r = await eraseSubtitleAndWait(sh.videoUrl, {
        intervalMs: 5000,
        onTick: () => { tick++; setBusy(b => ({ ...b, [id]: Math.min(94, 5 + tick * 7) })) },
      })
      const url = r?.data?.video_url || r?.video_url || r?.data?.result_url || r?.result_url || r?.data?.content?.video_url || r?.content?.video_url
      if (!url) throw new Error('字幕擦除完成但没有返回处理后视频地址')
      dispatch({ type: 'setProcessedVideo', id, url, erased: true })
      toast(`${sh.no} 字幕擦除完成 · 已进入处理结果区`)
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 160)
      dispatch({ type: 'setProcessError', id, err })
      toast(`${sh.no} 字幕擦除失败：${err}`, { tone: 'warn' })
    } finally {
      setBusy(b => { const n = { ...b }; delete n[id]; return n })
    }
  }
  const eraseAll = async () => {
    for (const sh of targets.filter(s => !s.processedVideoUrl)) await eraseOne(sh.id)
  }

  return (
    <div className="process-page">
      <div className="process-head">
        <div><div className="process-title">原料视频</div><div className="process-note">这里保留 2.0 复刻生成的原始视频。选择需要处理的片段，再执行字幕擦除。</div></div>
        <div className="process-actions"><span className="process-count">已处理 {processed.length}/{targets.length}</span><button className="btn btn--primary" onClick={eraseAll} disabled={!targets.some(s => !s.processedVideoUrl) || Object.keys(busy).length > 0}>擦除全部选中</button></div>
      </div>
      <div className="process-source-grid">
        {shots.map(s => {
          const progress = busy[s.id]
          return <article key={s.id} className="process-source-card">
            <div className="process-card-head"><span>{s.no} <i>{s.range}</i></span><button className={`sw ${s.eraseOn ? 'on' : ''}`} title="是否处理这个片段" onClick={() => dispatch({ type: 'toggleErase', id: s.id })} /></div>
            <div className="process-video">{s.videoUrl ? <video src={s.videoUrl} controls playsInline preload="metadata" /> : <span>尚未生成复刻视频</span>}</div>
            <div className="process-card-foot">
              <span className={`st-chip ${s.processedVideoUrl ? 'st-done' : progress !== undefined ? 'st-run' : s.processError ? 'st-fail' : s.eraseOn ? 'st-queue' : ''}`}><span className="st-dot" />{s.processedVideoUrl ? '已处理' : progress !== undefined ? `处理中 ${progress}%` : s.eraseOn ? '待处理' : '跳过'}</span>
              {s.eraseOn && <button className="rerun" onClick={() => eraseOne(s.id)} disabled={!s.videoUrl || progress !== undefined}>{s.processedVideoUrl ? '↻ 重处理' : '▸ 去字幕'}</button>}
            </div>
            {progress !== undefined && <div className="prog"><i style={{ ['--p' as any]: progress / 100 }} /></div>}
            {s.processError && <div className="process-error">{s.processError}</div>}
          </article>
        })}
      </div>

      <div className="process-result-head"><div><div className="process-title">处理结果</div><div className="process-note">字幕擦除等后处理完成的视频集中在这里；4.0 合成成片将优先使用这些结果。</div></div><span className="process-count">{processed.length} 个输出</span></div>
      {processed.length ? <div className="process-result-grid">{processed.map(s => <article key={s.id} className="process-result-card"><div className="process-result-label">{s.no} · 已去字幕</div><video src={s.processedVideoUrl} controls playsInline preload="metadata" /><a href={s.processedVideoUrl} target="_blank" rel="noreferrer">⇩ 下载处理视频</a></article>)}</div> : <div className="process-empty">尚无处理结果。原料视频不会被覆盖，完成去字幕后会在此处出现独立的新视频。</div>}
    </div>
  )
}

/* ---- 4.0 合成成片：可编辑轨道（片段裁剪/变速/排序 + 音频上传/生成 + 字幕轨） ---- */
const CLIP_SPEEDS = [0.5, 1, 1.5, 2]
export function Step4Compose() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const shots = state.shots
  const audioRef = useRef<HTMLInputElement>(null)
  const audioTrackRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<string | null>(shots[0]?.id ?? null)
  const [audioModal, setAudioModal] = useState(false)      // Generation 弹窗
  const [trimClip, setTrimClip] = useState<{ name: string; duration: number } | null>(null) // Trim 弹窗
  const [selAudio, setSelAudio] = useState<string | null>(null)   // 选中的音频片段（用于显示裁剪把手）
  const [audioMenu, setAudioMenu] = useState(false)               // 音轨 + 的上传/生成菜单
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(0) // 秒
  const raf = useRef<number>(0); const last = useRef<number>(0)
  const [dragIdx, setDragIdx] = useState<number | null>(null)   // 拖拽中的片段下标（仅用于视觉态）
  const [overIdx, setOverIdx] = useState<number | null>(null)   // 拖拽悬停目标下标（仅用于视觉态）
  const dragRef = useRef<{ from: number | null; to: number | null }>({ from: null, to: null })

  const clipDuration = (s: typeof shots[number]) => s.generatedDuration || s.genDuration
  const effDur = (s: typeof shots[number]) => Math.max(0.1, (Math.min(s.trimEnd, clipDuration(s)) - Math.min(s.trimStart, clipDuration(s) - 0.1)) / s.speed)
  const mediaUrl = (s: typeof shots[number]) => s.processedVideoUrl || s.videoUrl
  const totalDur = shots.reduce((a, s) => a + effDur(s), 0)
  const selShot = shots.find(s => s.id === sel) || null

  // 播放头推进
  useEffect(() => {
    if (!playing) return
    last.current = performance.now()
    const tick = (now: number) => {
      const dt = (now - last.current) / 1000; last.current = now
      setPlayhead(p => { const n = p + dt; return n >= totalDur ? 0 : n })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, totalDur])

  // 当前播放头落在哪个片段
  const acc: { s: typeof shots[number]; x0: number; x1: number }[] = []
  { let x = 0; for (const s of shots) { const d = effDur(s); acc.push({ s, x0: x, x1: x + d }); x += d } }
  const activeClip = acc.find(a => playhead >= a.x0 && playhead < a.x1)?.s || selShot
  const previewShot = activeClip

  // 新音频追加到音轨已有片段之后
  const nextAudioStart = () => state.compose.audios.reduce((mx, c) => Math.max(mx, c.start + (c.trimEnd - c.trimStart)), 0)
  const uploadAudio = (f: File) => {
    const dur = 30
    dispatch({ type: 'addAudio', clip: { id: uid(), name: f.name, source: 'upload', duration: dur, url: URL.createObjectURL(f), inTrack: true, start: nextAudioStart(), trimStart: 0, trimEnd: dur } })
    toast(`音频 · ${f.name}`)
  }
  // 生成音频流程：Generation 弹窗 → 生成 → Trim 裁剪 → 置入音轨
  const onGenerated = (name: string, duration: number) => { setAudioModal(false); setTrimClip({ name, duration }) }
  const onTrimConfirm = (name: string, len: number) => {
    setTrimClip(null)
    dispatch({ type: 'addAudio', clip: { id: uid(), name: `${name} · ${len.toFixed(1)}s`, source: 'generate', duration: len, url: null, inTrack: true, start: nextAudioStart(), trimStart: 0, trimEnd: len } })
    toast('音轨已置入')
  }

  const fmt = (s: number) => `00:${String(Math.floor(s)).padStart(2, '0')}`
  const ticks = Array.from({ length: Math.ceil(totalDur) + 1 }, (_, i) => i)
  const audioClips = state.compose.audios.filter(c => c.inTrack)
  const canRender = shots.length > 0 && shots.every(s => !!mediaUrl(s))
  const runRender = async () => {
    if (!canRender) { toast('仍有分镜没有可合成的视频，请先完成 2.0 视频复刻', { tone: 'warn' }); return }
    dispatch({ type: 'setRenderStatus', status: 'running' })
    try {
      const r = await renderComposition({
        clips: shots.map(s => ({ url: mediaUrl(s)!, trimStart: Math.min(s.trimStart, clipDuration(s) - 0.1), trimEnd: Math.min(s.trimEnd, clipDuration(s)), duration: clipDuration(s), speed: s.speed })),
        subtitleOn: state.compose.subtitleOn,
        subtitles: state.compose.subs,
      })
      dispatch({ type: 'setRenderStatus', status: 'done', url: r.video_url })
      toast('成片已合成 · 字幕已烧录')
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 180)
      dispatch({ type: 'setRenderStatus', status: 'failed', err })
      toast('合成失败：' + err, { tone: 'warn' })
    }
  }

  // 点时间轴定位播放头
  const seekAt = (e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    setPlayhead(Math.max(0, Math.min(totalDur, x * totalDur)))
  }

  // 片段上拖拽裁剪：按片段块像素宽换算 trim 秒（片段块宽 = 全片 duration 的 trim 后有效段映射）
  const startTrim = (shot: typeof shots[number], edge: 'in' | 'out', clipEl: HTMLElement) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    // 片段块像素宽当前代表「裁剪后有效时长」，把它反推到「完整 duration」的像素比例
    const rect = clipEl.getBoundingClientRect()
    const visLen = (shot.trimEnd - shot.trimStart) || 0.1
    const pxPerSec = rect.width / visLen        // 当前片段块 1 秒 = 多少像素
    const startX = e.clientX
    const s0 = shot.trimStart, e0 = shot.trimEnd
    const move = (ev: PointerEvent) => {
      const dSec = (ev.clientX - startX) / pxPerSec
      if (edge === 'in') {
        const v = Math.max(0, Math.min(e0 - 0.2, s0 + dSec))
        dispatch({ type: 'editShot', id: shot.id, patch: { trimStart: +v.toFixed(1) } })
      } else {
        const v = Math.min(clipDuration(shot), Math.max(s0 + 0.2, e0 + dSec))
        dispatch({ type: 'editShot', id: shot.id, patch: { trimEnd: +v.toFixed(1) } })
      }
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // 音轨时长基准（全片）：跟裁剪后的有效时长走，不是原片时长
  // The compose timeline follows the generated clips, not the source video's length.
  const audioSpan = totalDur || 45
  // 音频片段：拖动整体位置
  const startAudioMove = (clip: AudioClip, trackEl: HTMLElement) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    setSelAudio(clip.id)
    const pxPerSec = trackEl.getBoundingClientRect().width / audioSpan
    const startX = e.clientX; const st0 = clip.start
    const len = clip.trimEnd - clip.trimStart
    const move = (ev: PointerEvent) => {
      const v = Math.max(0, Math.min(audioSpan - len, st0 + (ev.clientX - startX) / pxPerSec))
      dispatch({ type: 'editAudio', id: clip.id, patch: { start: +v.toFixed(1) } })
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  // 音频片段：两端裁剪
  const startAudioTrim = (clip: AudioClip, edge: 'in' | 'out', trackEl: HTMLElement) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    const pxPerSec = trackEl.getBoundingClientRect().width / audioSpan
    const startX = e.clientX; const s0 = clip.trimStart, e0 = clip.trimEnd, st0 = clip.start
    const move = (ev: PointerEvent) => {
      const dSec = (ev.clientX - startX) / pxPerSec
      if (edge === 'in') {
        const v = Math.max(0, Math.min(e0 - 0.2, s0 + dSec))
        dispatch({ type: 'editAudio', id: clip.id, patch: { trimStart: +v.toFixed(1), start: +(st0 + (v - s0)).toFixed(1) } })
      } else {
        const v = Math.min(clip.duration, Math.max(s0 + 0.2, e0 + dSec))
        dispatch({ type: 'editAudio', id: clip.id, patch: { trimEnd: +v.toFixed(1) } })
      }
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  return (
    <div className="editor">
      {/* 预览区：优先播 2.0 视频复刻生成的视频，没有才回退参考图/占位。 */}
      <div className="ed-stage">
        <div className="ed-screen">
          {state.compose.renderedVideoUrl
            ? <video key={state.compose.renderedVideoUrl} src={state.compose.renderedVideoUrl} className="ed-frame" controls playsInline />
            : previewShot && mediaUrl(previewShot)
            ? <video key={previewShot.id} src={mediaUrl(previewShot)} className="ed-frame" muted loop playsInline autoPlay={playing} />
            : previewShot?.refs[0]
              ? <img src={previewShot.refs[0].url} alt="" className="ed-frame" />
              : <div className="ed-frame ed-ph"><span>{previewShot ? previewShot.no : '成片预览'}</span></div>}
        </div>
        <div className="ed-transport">
          <span className="ed-time">{fmt(playhead)} / {fmt(totalDur)}</span>
          <div className="ed-tbtns">
            <button className="ed-play" onClick={() => setPlaying(p => !p)}>{playing ? '❙❙' : '▶'}</button>
          </div>
          <div className="ed-tright">
            <button className="pv-icon" title="音量">🔊</button>
            <button className="pv-icon" title="全屏" onClick={() => toast('全屏预览')}>⤢</button>
            <button className="btn btn--primary" style={{ padding: '7px 14px', fontSize: 13 }} onClick={runRender} disabled={!canRender || state.compose.renderStatus === 'running'}>{state.compose.renderStatus === 'running' ? '合成中…' : '▸ 合成成片'}</button>
          </div>
        </div>
        {/* 选中片段操作条——附在预览器内，紧凑一行 */}
        {selShot && (
          <div className="ed-clipbar">
            <span className="ed-clipname">{selShot.no}</span>
            <span className="ed-mono">裁剪 {selShot.trimStart.toFixed(1)}–{selShot.trimEnd.toFixed(1)}s · 有效 {effDur(selShot).toFixed(1)}s</span>
            <span className="ed-sep" />
            <span className="ed-lb">变速</span>
            <div className="chips">{CLIP_SPEEDS.map(sp => <button key={sp} className={`chip chip-sm ${selShot.speed === sp ? 'sel' : ''}`} onClick={() => dispatch({ type: 'editShot', id: selShot.id, patch: { speed: sp } })}>{sp}×</button>)}</div>
          </div>
        )}
      </div>

      {/* 时间轴 */}
      <div className="ed-timeline">
        {/* 刻度尺 */}
        <div className="ed-ruler-row">
          <div className="ed-thead" />
          <div className="ed-ruler" onClick={seekAt}>
            {ticks.map(t => <span key={t} className="ed-tick" style={{ left: `${(t / totalDur) * 100}%` }}>{fmt(t)}</span>)}
            <div className="ed-playhead" style={{ left: `${(playhead / totalDur) * 100}%` }}><span className="ed-playhead-knob" /></div>
          </div>
        </div>
        {/* 字幕轨：单开关；开启时可增删多段字幕，文本可编辑 */}
        <div className="ed-track-row has-add">
          <div className="ed-thead">
            字幕
            <button className={`sw sw-sm ${state.compose.subtitleOn ? 'on' : ''}`} title="字幕开关"
              onClick={() => dispatch({ type: 'toggleSubtitle' })} />
          </div>
          <div className="ed-track" onClick={seekAt}>
            {state.compose.subtitleOn ? (
              <div className="ed-clips" style={{ gap: 4 }}>
                {state.compose.subs.length === 0
                  ? <span className="ed-empty">字幕已开启 · 点右侧 + 增加字幕段</span>
                  : state.compose.subs.map(sub => (
                    <div key={sub.id} className="ed-clip sub" style={{ width: `${((sub.end - sub.start) / audioSpan) * 100}%` }} title={sub.text}>
                      <input className="ed-sub-input" value={sub.text} onClick={ev => ev.stopPropagation()}
                        onChange={e => dispatch({ type: 'editSub', id: sub.id, patch: { text: e.target.value } })} />
                      <button className="ed-clip-x" onClick={ev => { ev.stopPropagation(); dispatch({ type: 'delSub', id: sub.id }) }}>×</button>
                    </div>
                  ))}
              </div>
              ) : <span className="ed-empty">字幕已关闭</span>}
            <div className="ed-playhead" style={{ left: `${(playhead / totalDur) * 100}%` }} />
          </div>
          <div className="ed-track-add">
            {state.compose.subtitleOn && <button className="ed-add-btn" title="增加字幕" onClick={() => dispatch({ type: 'addSub' })}>+</button>}
          </div>
        </div>

        {/* 视频轨：可拖拽换位，选中片段可在两端拖动裁剪 */}
        <div className="ed-track-row">
          <div className="ed-thead">视频轨</div>
          <div className="ed-track" onClick={seekAt}>
            <div className="ed-clips">
              {shots.map((s, idx) => (
                <div key={s.id}
                  className={`ed-clip vid ${sel === s.id ? 'on' : ''} ${dragIdx === idx ? 'dragging' : ''} ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? 'drop-target' : ''}`}
                  title={`${s.no} · ${effDur(s).toFixed(1)}s · 拖拽可改顺序`}
                  style={{ width: `${(effDur(s) / totalDur) * 100}%` }}
                  draggable
                  onDragStart={() => { dragRef.current.from = idx; setDragIdx(idx) }}
                  onDragOver={ev => { ev.preventDefault(); dragRef.current.to = idx; setOverIdx(idx) }}
                  onDrop={ev => { ev.preventDefault(); dragRef.current.to = idx }}
                  onDragEnd={() => { const { from, to } = dragRef.current; if (from !== null && to !== null && from !== to) { const f=from,tt=to; dispatch({ type: 'reorderShots', from: f, to: tt }); toast('片段顺序已调', { undo: () => dispatch({ type: 'reorderShots', from: tt, to: f }) }) } dragRef.current = { from: null, to: null }; setDragIdx(null); setOverIdx(null) }}
                  onClick={ev => { ev.stopPropagation(); setSel(s.id) }}>
                  {mediaUrl(s)
                    ? <video src={mediaUrl(s)} className="ed-clip-thumb" muted preload="metadata" />
                    : s.refs[0] && <img src={s.refs[0].url} alt="" className="ed-clip-thumb" />}
                  <span className="ed-clip-label">{s.no}{s.speed !== 1 ? ` ${s.speed}×` : ''}</span>
                  {sel === s.id && (
                    <>
                      <span className="ed-trim-h in" onPointerDown={e => startTrim(s, 'in', e.currentTarget.parentElement as HTMLElement)(e)} title="拖动裁剪起点" />
                      <span className="ed-trim-h out" onPointerDown={e => startTrim(s, 'out', e.currentTarget.parentElement as HTMLElement)(e)} title="拖动裁剪终点" />
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="ed-playhead" style={{ left: `${(playhead / totalDur) * 100}%` }} />
          </div>
        </div>
        {/* 音频轨：多段，绝对定位，可整体拖动、两端裁剪；末尾 + 增加音频 */}
        <div className="ed-track-row has-add">
          <div className="ed-thead">音频轨</div>
          <div className="ed-track ed-track-abs" onClick={e => { seekAt(e); setSelAudio(null) }} ref={audioTrackRef}>
            {audioClips.length === 0 && <span className="ed-empty">暂无音频，点右侧 + 上传 / 生成</span>}
            {audioClips.map(c => {
              const len = c.trimEnd - c.trimStart
              return (
                <div key={c.id} className={`ed-clip aud abs ${selAudio === c.id ? 'on' : ''}`}
                  title={`${c.name} · ${len.toFixed(1)}s`}
                  style={{ left: `${(c.start / audioSpan) * 100}%`, width: `${(len / audioSpan) * 100}%` }}
                  onPointerDown={e => startAudioMove(c, audioTrackRef.current!)(e)}
                  onClick={ev => { ev.stopPropagation(); setSelAudio(c.id) }}>
                  <span className="ed-clip-label">{c.source === 'generate' ? '♪ ' : '⬆ '}{c.name}</span>
                  <button className="ed-clip-x" onPointerDown={ev => ev.stopPropagation()} onClick={ev => { ev.stopPropagation(); dispatch({ type: 'delAudio', id: c.id }); if (selAudio === c.id) setSelAudio(null) }}>×</button>
                  {selAudio === c.id && (
                    <>
                      <span className="ed-trim-h in" onPointerDown={e => { e.stopPropagation(); startAudioTrim(c, 'in', audioTrackRef.current!)(e) }} title="裁剪起点" />
                      <span className="ed-trim-h out" onPointerDown={e => { e.stopPropagation(); startAudioTrim(c, 'out', audioTrackRef.current!)(e) }} title="裁剪终点" />
                    </>
                  )}
                </div>
              )
            })}
            <div className="ed-playhead" style={{ left: `${(playhead / totalDur) * 100}%` }} />
          </div>
          <div className="ed-track-add">
            <button className="ed-add-btn" title="增加音频" onClick={() => setAudioMenu(v => !v)}>+</button>
            {audioMenu && (
              <div className="ed-add-menu">
                <button onClick={() => { setAudioMenu(false); audioRef.current?.click() }}>⬆ 上传音频</button>
                <button onClick={() => { setAudioMenu(false); setAudioModal(true) }}>♪ 生成音频</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部操作条 */}
      <div className="ed-toolbar">
        <input ref={audioRef} type="file" accept="audio/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) uploadAudio(f); e.target.value = '' }} />
        {state.compose.renderedVideoUrl && <a className="ed-render-download" href={state.compose.renderedVideoUrl} download="toushi-final.mp4">⇩ 下载合成 MP4</a>}
        {state.compose.renderStatus === 'failed' && <span className="ed-render-error">{state.compose.renderError}</span>}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-ink-3)' }}>合计 {totalDur.toFixed(1)}s · {shots.length} 片段 · {audioClips.length} 音轨 · 字幕 {state.compose.subtitleOn ? `${state.compose.subs.length} 段` : '关'}</span>
      </div>

      {audioModal && <AudioGenModal onClose={() => setAudioModal(false)} onGenerated={onGenerated} />}
      {trimClip && <AudioTrimModal clip={trimClip} onClose={() => setTrimClip(null)} onConfirm={onTrimConfirm} />}
    </div>
  )
}

/* ---- 音频生成弹窗（参考 Wan Generation） ----
   ⚠️ 后端暂无 TTS 接口，本弹窗生成的音频是占位数据（url:null，无法播放）。 */
const VOICES = ['Classic Lady', 'Warm Guy', 'Steady Lady', 'Gentle Man', 'Chill Girl', 'Sweet Girl', 'Calm Boy', 'Lively Girl', 'Elegant Girl', 'Joyful Girl', 'Playful Girl', 'Bright Girl', 'Deep Male', 'Crisp Girl']
function AudioGenModal({ onClose, onGenerated }: { onClose: () => void; onGenerated: (name: string, dur: number) => void }) {
  const [text, setText] = useState('')
  const [voice, setVoice] = useState('Classic Lady')
  const [busy, setBusy] = useState(false)
  const next = () => {
    if (!text.trim()) return
    setBusy(true)
    setTimeout(() => { setBusy(false); onGenerated(`${voice} · 配音`, Math.min(15, Math.max(3, Math.round(text.length / 8)))) }, 1200)
  }
  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-box" style={{ width: 'min(700px,94vw)' }}>
        <div className="modal-head"><span className="modal-title">Generation · 生成音频 <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-warn)', marginLeft: 6 }}>MOCK</span></span><button className="pv-icon" aria-label="关闭" onClick={onClose}><X size={17} /></button></div>
        <div className="modal-body">
          <div className="gen-input">
            <textarea placeholder="输入希望角色说出的台词…" maxLength={300} value={text} onChange={e => setText(e.target.value)} />
            <div className="gen-input-foot">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ink-3)' }}>暂无配音接口，生成为占位音频</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ink-3)' }}>{text.length}/300</span>
            </div>
          </div>
          <div className="gen-voices">
            {VOICES.map(v => (
              <button key={v} className={`gen-voice ${voice === v ? 'on' : ''}`} onClick={() => setVoice(v)}>
                <span className="gen-wave">≋</span>{v}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!text.trim() || busy} onClick={next}>{busy ? '生成中…' : 'Next'}</button>
        </div>
      </div>
    </div>
  )
}

/* ---- 音频裁剪弹窗（参考 Wan Trim，波形 + 双把手） ---- */
function AudioTrimModal({ clip, onClose, onConfirm }: { clip: { name: string; duration: number }; onClose: () => void; onConfirm: (name: string, len: number) => void }) {
  const dur = Math.max(clip.duration, 7)
  const [inS, setInS] = useState(1)
  const [outS, setOutS] = useState(Math.min(dur, 15))
  const bars = Array.from({ length: 48 }, (_, i) => 20 + Math.abs(Math.sin(i * 0.9) * 60) + (i % 3 === 0 ? 15 : 0))
  const inPct = (inS / dur) * 100, outPct = (outS / dur) * 100
  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-box" style={{ width: 'min(760px,94vw)' }}>
        <div className="modal-head"><span className="modal-title">Trim · 裁剪音频</span><button className="pv-icon" aria-label="关闭" onClick={onClose}><X size={17} /></button></div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: 'var(--color-ink-3)', marginBottom: 16 }}>请将音频裁剪到 1.0s – 15.0s（{clip.name}）</div>
          <div className="trim-row">
            <button className="trim-play">▶ <span className="ed-mono">00:00/00:0{Math.round(dur) % 10}</span></button>
            <div className="trim-wave">
              <div className="trim-sel" style={{ left: `${inPct}%`, right: `${100 - outPct}%` }} />
              <div className="trim-bars">
                {bars.map((h, i) => {
                  const p = (i / bars.length) * 100
                  const inRange = p >= inPct && p <= outPct
                  return <span key={i} className="trim-bar" style={{ height: `${h}%`, background: inRange ? 'var(--color-accent)' : 'var(--color-rule-2)' }} />
                })}
              </div>
              <div className="trim-handle" style={{ left: `${inPct}%` }} />
              <div className="trim-handle" style={{ left: `${outPct}%` }} />
              <input type="range" className="trim-range" min={0} max={dur} step={0.1} value={inS} onChange={e => setInS(Math.min(+e.target.value, outS - 1))} />
              <input type="range" className="trim-range" min={0} max={dur} step={0.1} value={outS} onChange={e => setOutS(Math.max(+e.target.value, inS + 1))} />
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-accent)', marginTop: 10, textAlign: 'right' }}>选段 {inS.toFixed(1)}s – {outS.toFixed(1)}s · 共 {(outS - inS).toFixed(1)}s</div>
        </div>
        <div className="modal-foot">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={() => onConfirm(clip.name, outS - inS)}>Confirm</button>
        </div>
      </div>
    </div>
  )
}

/* ---- 5.0 封面标题：Seedream 生图 + 豆包 2.1 Pro 标题 ---- */
function imageUrlFromResult(r: any): string | null {
  return r?.data?.[0]?.url || r?.data?.[0]?.image_url || r?.data?.data?.[0]?.url || r?.data?.image_url || r?.data?.url || r?.url || r?.image_url || null
}
export function Step5Cover() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [genC, setGenC] = useState(false)
  const [genT, setGenT] = useState(false)
  const [coverErr, setCoverErr] = useState('')
  const [titleErr, setTitleErr] = useState('')
  const [coverAspect, setCoverAspect] = useState<'9:16' | '16:9'>('9:16')
  const [exporting, setExporting] = useState(false)
  const [exportUrl, setExportUrl] = useState('')
  const strategy = state.strategySkill
  const sourceShot = state.shots.find(s => s.processedVideoUrl || s.videoUrl)
  const coverPrompt = [
    `为短视频广告生成一张高点击率 ${coverAspect} 画幅封面，不要水印，不要无意义文字，不要拼贴UI。`,
    `成片核心卖点：${strategy?.strategy?.core_selling_point || sourceShot?.visualHint || '产品卖点'}`,
    `表达风格：${strategy?.strategy?.expression_style || '干净、有质感'}`, 
    `首个分镜画面：${sourceShot?.prompt || sourceShot?.visualHint || ''}`,
    `封面要求：主体明确，留出上方或下方标题安全区，${coverAspect}，广告摄影质感。`, 
  ].join('\n')
  const titleContext = [
    `核心卖点：${strategy?.strategy?.core_selling_point || ''}`,
    `表达方式：${strategy?.strategy?.expression_style || ''}`,
    `叙事结构：${strategy?.strategy?.narrative_structure || ''}`,
    `钩子：${strategy?.strategy?.attention_hooks?.pre_roll || ''}`,
    `视频片段：${state.shots.map(s => `${s.no}:${s.voiceover}`).join(' / ')}`,
  ].join('\n')

  const genCover = async () => {
    setGenC(true); setCoverErr('')
    try {
      const r = await generateImage({ model: 'doubao-seedream-5.0-lite', prompt: coverPrompt, aspect_ratio: coverAspect, size: coverAspect === '9:16' ? '1440x2560' : '2560x1440', watermark: false })
      const url = imageUrlFromResult(r)
      if (!url) throw new Error('封面生成完成，但未返回可展示的图片地址：' + JSON.stringify(r).slice(0, 260))
      const label = `AI · ${strategy?.meta?.title || '成片封面'} · ${coverAspect}`
      dispatch({ type: 'addCover', cover: { id: uid(), label, kind: 'ai', url, aspect: coverAspect } })
      toast('封面已生成')
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 220); setCoverErr(err); toast('封面生成失败：' + err, { tone: 'warn' })
    } finally { setGenC(false) }
  }
  const genTitle = async () => {
    setGenT(true); setTitleErr('')
    try {
      const r = await generateTitles(titleContext)
      const raw = r?.choices?.[0]?.message?.content ?? r?.data?.choices?.[0]?.message?.content ?? ''
      const parsed: any = extractJson(raw)
      const titles = Array.isArray(parsed?.titles) ? parsed.titles : []
      if (!titles.length) throw new Error('未返回可用的标题结果：' + String(raw).slice(0, 220))
      titles.slice(0, 3).forEach((t: any) => dispatch({ type: 'addTitle', title: { id: uid(), text: String(t.text || '').slice(0, 40), tag: String(t.tag || 'AI · 标题策略').slice(0, 24), ai: true } }))
      toast(`已生成 ${Math.min(3, titles.length)} 个标题`)
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 220); setTitleErr(err); toast('标题生成失败：' + err, { tone: 'warn' })
    } finally { setGenT(false) }
  }
  const exportPackage = async () => {
    const cover = state.covers[state.cover]
    const title = state.titles[state.title]
    if (!state.compose.renderedVideoUrl || !cover?.url || !title?.text) {
      toast('请先完成成片合成，并选择封面和标题', { tone: 'warn' })
      return
    }
    setExporting(true)
    try {
      const r = await exportDeliveryPackage({ video_url: state.compose.renderedVideoUrl, cover_url: cover.url, title: title.text })
      setExportUrl(r.package_url)
      toast('交付包已生成')
    } catch (e: any) {
      toast('交付包导出失败：' + String(e?.message || e).slice(0, 160), { tone: 'warn' })
    } finally { setExporting(false) }
  }

  return (
    <div className="cover-page">
      <section className="cover-section">
        <div className="cover-section-head"><div><div className="col-label">封面</div><div className="cover-note">基于已反推的卖点、风格和首个分镜生成封面。</div></div><div className="cover-actions"><div className="chips">{(['9:16', '16:9'] as const).map(ar => <button key={ar} className={`chip chip-sm ${coverAspect === ar ? 'sel' : ''}`} onClick={() => setCoverAspect(ar)}>{ar}</button>)}</div><button className="btn btn--primary btn-with-icon" onClick={genCover} disabled={genC}>{!genC && <Sparkles size={15} />}{genC ? '正在生成…' : '生成封面'}</button></div></div>
        {coverErr && <div className="cover-error">{coverErr}</div>}
        <div className="cover-grid">{state.covers.map((c, k) => <div key={c.id} className={`cover ${state.cover === k ? 'sel' : ''}`} onClick={() => dispatch({ type: 'setCover', i: k })}><div className={`cap thumb-dark ${c.aspect === '16:9' ? 'is-wide' : ''}`}>{c.url ? <img src={c.url} alt={c.label} /> : <span>无图片</span>}</div><div className="lb">{c.label}<span>{state.cover === k ? '★ 已选' : ''}</span></div></div>)}</div>
        {!state.covers.length && <div className="cover-empty">尚未生成封面。选择画幅后点击生成封面。</div>}
      </section>
      <section className="title-section">
        <div className="cover-section-head"><div><div className="col-label">标题</div><div className="cover-note">基于整片策略与口播生成投放标题候选。</div></div><button className="chip btn-with-icon" onClick={genTitle} disabled={genT}>{!genT && <Sparkles size={14} />}{genT ? '正在生成…' : '生成标题'}</button></div>
        {titleErr && <div className="cover-error">{titleErr}</div>}
        {state.titles.map((t, k) => <div key={t.id} className={`title-opt ${state.title === k ? 'sel' : ''}`} onClick={() => dispatch({ type: 'setTitle', i: k })}><div className="t">{t.text}</div><div className="m">{t.ai ? '✦ ' : ''}{t.tag}</div></div>)}
        {!state.titles.length && <div className="cover-empty">尚未生成标题。生成后可从多个候选中选择。</div>}
        <div className="panel cover-delivery"><div className="col-label">交付包</div><div><CheckCircle2 size={13} /> 成片 {state.compose.renderedVideoUrl ? <a href={state.compose.renderedVideoUrl} download="toushi-final.mp4">下载合成 MP4</a> : '尚未合成'}<br /><CheckCircle2 size={13} /> 封面 {state.covers[state.cover]?.label || '尚未选择'}<br /><CheckCircle2 size={13} /> 标题「{state.titles[state.title]?.text || '尚未选择'}」</div><button className="btn btn--primary btn-with-icon" onClick={exportPackage} disabled={exporting}>{!exporting && <Download size={15} />}{exporting ? '打包中…' : '导出交付包'}</button>{exportUrl && <a className="cover-package-link" href={exportUrl} download="toushi-delivery.zip"><Download size={14} />下载交付包 ZIP</a>}</div>
      </section>
    </div>
  )
}
