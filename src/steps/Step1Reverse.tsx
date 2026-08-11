import { useRef, useState, useEffect } from 'react'
import { useStore, useToast, ROLE } from '../store'
import {
  probeMuseReady,
  uploadVideoRawFromBlobUrl, uploadVideoRaw, importVideoUrl, trimVideoOnServer,
  videoPreviewUrl, TRIM_MIN_SEC, TRIM_MAX_SEC, breakdownStrategy,
  transcribeVideo,
} from '../lib/museApi'
import { extractJson } from '../lib/parseJson'
import { ShotSplitControl } from '../components/ShotSplitControl'
import { ArrowRight, Link2, Play, Plus, RotateCcw, ShieldCheck, Sparkles, Upload as UploadIcon, X } from 'lucide-react'

const CROP_MIN = TRIM_MIN_SEC   // 最短裁剪（3s）
const CROP_MAX = TRIM_MAX_SEC   // 最长裁剪（180s）· 服务端 ffmpeg 真裁剪

/* ============================================================================
   1.0 视频反推：上传/裁剪 → 豆包2.1 Pro整片拆镜 → 成片策略 → 分镜拆分（入口一）。
   逐片段反推和新视频生成已迁移到独立的 2.0 视频复刻。
============================================================================ */
export function Step1Reverse() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [cropOpen, setCropOpen] = useState(false)
  const [started, setStarted] = useState(false)

  const hasVideo = !!state.source.objectUrl
  const trimmed = !!state.source.trimmedId
  const analyzingOrDone = started || state.analyzing || state.analyzed

  if (analyzingOrDone) return <Analyze />

  return (
    <>
      {!hasVideo && <Upload onUploaded={() => setCropOpen(true)} />}
      {hasVideo && (
        <Preview
          onRecrop={() => setCropOpen(true)}
          onReupload={() => { dispatch({ type: 'resetSource' }); setCropOpen(false) }}
          onClear={() => { dispatch({ type: 'resetSource' }); setCropOpen(false); toast('已清空参考视频') }}
          onRun={() => setStarted(true)}
          trimmed={trimmed}
        />
      )}

      {cropOpen && (
        <CropModal onClose={() => setCropOpen(false)} onConfirm={() => setCropOpen(false)} />
      )}
    </>
  )
}

/* ---- 上传框：右上「本地上传」+ 大拖拽区 + 独立网址行 ---- */
function Upload({ onUploaded }: { onUploaded: () => void }) {
  const { dispatch } = useStore()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [upPct, setUpPct] = useState(0)
  const [sourceMode, setSourceMode] = useState<'file' | 'url'>('file')

  function handleFile(f: File) {
    const url = URL.createObjectURL(f)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = async () => {
      const durationS = Math.round(v.duration || 0)
      dispatch({
        type: 'setNewSource',
        source: {
          name: f.name,
          sizeMB: +(f.size / 1024 / 1024).toFixed(1),
          durationS,
          resolution: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '未知',
          objectUrl: url,
          rawId: '', trimmedId: '',
        },
      })
      setUploading(true); setUpPct(0)
      try {
        const up = await uploadVideoRaw(f, { filename: f.name, onProgress: setUpPct })
        dispatch({ type: 'patchSource', source: { rawId: up.raw_id } })
        toast(`${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB · 已上传`)
      } catch (e: any) {
        toast('上传失败：' + String(e?.message || e).slice(0, 80), { tone: 'warn' })
      } finally {
        setUploading(false)
      }
      onUploaded()
    }
    v.onerror = () => { toast('无法读取视频元数据，请换 mp4/mov', { tone: 'warn' }) }
    v.src = url
  }

  async function handleUrl(raw: string) {
    const u = raw.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u)) { toast('请输入 http(s):// 开头的视频地址', { tone: 'warn' }); return }
    setUrlLoading(true)
    const name = decodeURIComponent(u.split('/').pop()?.split('?')[0] || '参考视频.mp4')
    try {
      const im = await importVideoUrl(u)
      const previewUrl = videoPreviewUrl(im.raw_id)
      const meta = await new Promise<{ d: number; r: string }>(resolve => {
        const v = document.createElement('video')
        v.preload = 'metadata'
        let settled = false
        const done = (d: number, r: string) => { if (!settled) { settled = true; resolve({ d, r }) } }
        v.onloadedmetadata = () => done(Math.round(v.duration || 0) || 60, v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '未知')
        v.onerror = () => done(60, '未知')
        setTimeout(() => done(60, '未知'), 6000)
        v.src = previewUrl
      })
      dispatch({
        type: 'setNewSource',
        source: { name, sizeMB: +(im.size / 1024 / 1024).toFixed(1), durationS: meta.d, resolution: meta.r, objectUrl: previewUrl, rawId: im.raw_id, trimmedId: '' },
      })
      toast(`已载入 URL · ${name} · ${(im.size / 1024 / 1024).toFixed(1)} MB`)
      onUploaded()
    } catch (e: any) {
      toast('URL 载入失败：' + String(e?.message || e).slice(0, 80), { tone: 'warn' })
    } finally {
      setUrlLoading(false)
    }
  }

  return (
    <div className="up">
      <div className="up-head">
        <div><div className="up-title">添加参考视频 <span className="req">*</span></div><p className="up-intro">选择一种方式开始，稍后可精确截取要分析的片段。</p></div>
        <span className="up-security"><ShieldCheck size={13} />仅用于本次创作</span>
      </div>

      <div className="up-mode" role="tablist" aria-label="视频来源">
        <button type="button" role="tab" aria-selected={sourceMode === 'file'} className={sourceMode === 'file' ? 'is-active' : ''} onClick={() => setSourceMode('file')}><span><UploadIcon size={16} /></span><b>上传本地视频</b><small>从电脑选择或拖拽文件</small></button>
        <button type="button" role="tab" aria-selected={sourceMode === 'url'} className={sourceMode === 'url' ? 'is-active' : ''} onClick={() => setSourceMode('url')}><span><Link2 size={16} /></span><b>粘贴视频链接</b><small>导入可公开访问的视频</small></button>
      </div>
      <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/*" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />

      {sourceMode === 'file' ? (
        <div className={`up-drop ${drag ? 'drag' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f) }}>
          <div className="up-ic" aria-hidden><Plus size={24} strokeWidth={1.7} /></div>
          <div className="up-t">把视频拖到这里</div>
          <div className="up-s">或者 <strong>浏览电脑文件</strong></div>
          <div className="up-specs"><span>MP4 / MOV / WebM</span><span>最长 15 分钟</span><span>最大 2GB</span></div>
        </div>
      ) : (
        <div className="up-link-panel">
          <div className="up-link-icon"><Link2 size={21} /></div>
          <div className="up-link-copy"><b>粘贴视频的公开链接</b><span>支持以 http:// 或 https:// 开头的直接视频地址</span></div>
          <div className="up-link-field">
            <input className="edt" placeholder="https://example.com/video.mp4" value={urlInput} disabled={urlLoading} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleUrl(urlInput) }} />
            <button className="btn btn--primary" disabled={urlLoading || !urlInput.trim()} onClick={() => handleUrl(urlInput)}>{urlLoading ? '正在导入…' : '导入视频'}</button>
          </div>
          <small>导入后将自动进入片段裁剪，不会立即开始分析。</small>
        </div>
      )}

      {uploading && (
        <div className="up-prog">
          <div className="prog" style={{ flex: 1, height: 4 }}><i style={{ ['--p' as any]: `${upPct / 100}` }} /></div>
          <span>上传原片 {upPct}%</span>
        </div>
      )}

      <div className="up-next-hint"><span>接下来</span><b>选择关键片段</b><ArrowRight size={13} /><b><Sparkles size={13} />AI 拆解视频</b></div>
    </div>
  )
}

/* ---- 已裁剪预览：可播放 video + 已裁剪徽章 + 重新裁剪/重新上传/清空 → 开始分析 ---- */
function Preview({ onRecrop, onReupload, onClear, onRun, trimmed }: {
  onRecrop: () => void; onReupload: () => void; onClear: () => void; onRun: () => void; trimmed: boolean
}) {
  const { state } = useStore()
  const { start, end, enabled } = state.crop
  const trimmedSrc = trimmed && state.source.trimmedId ? videoPreviewUrl(state.source.trimmedId) : null
  const src = trimmedSrc || state.source.objectUrl || undefined
  const showTrimmed = !!trimmedSrc

  return (
    <div className="up">
      <div className="up-head">
        <div className="up-title">参考视频 <span className="req">*</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost btn--sm btn-with-icon" onClick={onReupload}><UploadIcon size={14} />重新上传</button>
          <button className="btn btn--ghost btn--sm btn-with-icon" onClick={onClear}><X size={14} />清空</button>
        </div>
      </div>

      <div className="pv-wrap">
        {src
          ? <video key={src} className="pv-video" src={src} controls playsInline preload="metadata"
              onLoadedMetadata={e => { if (!showTrimmed && enabled) (e.currentTarget as HTMLVideoElement).currentTime = start }} />
          : <div className="pv-ph"><Play size={17} /> {state.source.name}</div>}
        <div className="pv-badges">
          <span className="pv-badge">
            {enabled && trimmed ? `已裁剪 ${start.toFixed(1)}s ~ ${end.toFixed(1)}s` : `整段 ${state.source.durationS}s`}
          </span>
          <button className="pv-badge pv-badge--btn" onClick={onRecrop}>✂ 重新裁剪</button>
        </div>
      </div>

      <div className="pv-run">
        <button className="btn btn--primary up-run btn-with-icon" onClick={onRun} disabled={!trimmed}><Sparkles size={16} />开始分析</button>
        <span className="up-run-note">
          {trimmed ? `将分析裁剪片段 ${start.toFixed(1)}–${end.toFixed(1)}s，并生成拆镜与成片策略` : '请先完成裁剪，再开始整片反推'}
        </span>
      </div>
    </div>
  )
}

/* ---- 裁剪弹窗：竖版预览 + 双手柄轨道 + 起点/时长/终点读数 ---- */
function CropModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const dur = state.source.durationS || 45
  const winMax = Math.min(dur, CROP_MAX)
  const { start, end } = state.crop
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [trimming, setTrimming] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const drag = useRef<null | 'l' | 'r' | 'move'>(null)
  const dragBase = useRef({ start: 0, end: 0, x: 0 })

  const span = +(end - start).toFixed(1)
  const pctL = (start / dur) * 100
  const pctR = (end / dur) * 100

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      setCur(v.currentTime)
      if (v.currentTime >= end || v.currentTime < start - 0.3) v.currentTime = start
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => { v.removeEventListener('timeupdate', onTime); v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause) }
  }, [start, end])

  function commit(ns: number, ne: number) {
    ns = Math.max(0, Math.min(ns, dur))
    ne = Math.max(0, Math.min(ne, dur))
    if (ne - ns < CROP_MIN) ne = Math.min(dur, ns + CROP_MIN)
    if (ne - ns > winMax) ne = ns + winMax
    dispatch({ type: 'setCrop', crop: { start: +ns.toFixed(1), end: +ne.toFixed(1), enabled: true } })
    const v = videoRef.current; if (v) v.currentTime = ns
  }

  function startDrag(kind: 'l' | 'r' | 'move', e: React.PointerEvent) {
    e.preventDefault()
    drag.current = kind
    dragBase.current = { start, end, x: e.clientX }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current || !trackRef.current) return
    const w = trackRef.current.getBoundingClientRect().width
    const deltaS = ((e.clientX - dragBase.current.x) / w) * dur
    const b = dragBase.current
    if (drag.current === 'l') commit(b.start + deltaS, b.end)
    else if (drag.current === 'r') commit(b.start, b.end + deltaS)
    else {
      let ns = b.start + deltaS, ne = b.end + deltaS
      if (ns < 0) { ne -= ns; ns = 0 }
      if (ne > dur) { ns -= (ne - dur); ne = dur }
      commit(ns, ne)
    }
  }
  function endDrag() { drag.current = null }

  function togglePlay() {
    const v = videoRef.current; if (!v) return
    if (v.paused) { v.currentTime = Math.max(start, Math.min(v.currentTime, end)); v.play() } else v.pause()
  }

  async function confirm() {
    if (span < CROP_MIN || span > winMax) { toast(`片段需在 ${CROP_MIN}~${winMax}s 之间`, { tone: 'warn' }); return }
    let rawId = state.source.rawId
    setTrimming(true)
    try {
      if (!rawId) {
        if (!state.source.objectUrl) { toast('未检测到本地视频文件，请重新上传后再裁剪', { tone: 'warn' }); return }
        toast('未获取到已上传视频，正在重新上传…', { tone: 'warn' })
        try {
          const up = await uploadVideoRawFromBlobUrl(state.source.objectUrl, { filename: state.source.name })
          rawId = up.raw_id
          dispatch({ type: 'patchSource', source: { rawId } })
        } catch (upErr: any) {
          toast('重新上传失败，无法裁剪：' + String(upErr?.message || upErr).slice(0, 80), { tone: 'warn' })
          return
        }
      }
      const r = await trimVideoOnServer(rawId, start, end)
      dispatch({ type: 'patchSource', source: { trimmedId: r.trimmed_id } })
      toast(`已裁剪 ${span}s 片段 · ${(r.size / 1024 / 1024).toFixed(1)} MB`)
      onConfirm()
    } catch (e: any) {
      toast('裁剪失败：' + String(e?.message || e).slice(0, 80) + '，请重试', { tone: 'warn' })
    } finally {
      setTrimming(false)
    }
  }

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" aria-label="裁剪视频片段"
      onClick={e => { if (e.target === e.currentTarget && !trimming) onClose() }}>
      <div className="modal-card crop-modal">
        <div className="modal-head">
          <div>
            <div className="crop-modal-title">✂ 裁剪视频片段</div>
            <div className="crop-modal-sub">为获得最佳效果，请将参考视频裁剪到 {CROP_MIN}~{CROP_MAX} 秒的关键片段。</div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="关闭" disabled={trimming}><X size={17} /></button>
        </div>

        <div className="crop-stage">
          {state.source.objectUrl
            ? <video ref={videoRef} src={state.source.objectUrl} muted loop playsInline className="crop-stage-video" />
            : <div className="crop-stage-ph"><Play size={17} /> {state.source.name}</div>}
          <div className="crop-stage-ctrl">
            <button className="crop-play" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'}>{playing ? '❚❚' : '▶'}</button>
            <span className="crop-time">{fmt(cur)} / {fmt(dur)}</span>
          </div>
        </div>

        <div ref={trackRef} className="crop-track2" style={{ touchAction: 'none' }}
          onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div className="crop-sel2" style={{ left: `${pctL}%`, right: `${100 - pctR}%`, cursor: 'grab' }}
            onPointerDown={e => startDrag('move', e)}>
            <span className="crop-span-bubble">{span.toFixed(1)}s</span>
            <span className="crop-h2 l" onPointerDown={e => { e.stopPropagation(); startDrag('l', e) }} />
            <span className="crop-h2 r" onPointerDown={e => { e.stopPropagation(); startDrag('r', e) }} />
          </div>
        </div>

        <div className="crop-read">
          <span>起点：<b>{fmt(start)}</b></span>
          <span>选中时长：<b className="acc">{span.toFixed(1)}s</b> / 限定 {CROP_MIN}~{winMax}s</span>
          <span>终点：<b>{fmt(end)}</b></span>
        </div>
        <div className="crop-tip">提示：拖动两端手柄改变长度；按住选区中间可整体平移。</div>

        <div className="modal-foot">
          <button className="btn btn--ghost" onClick={onClose} disabled={trimming}>取消</button>
          <button className="btn btn--primary" onClick={confirm} disabled={trimming}>
            {trimming ? '裁剪中…' : '✂ 确认裁剪'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---- 分析：拆镜拉片专家 → 策略skill md 展示 → 分镜拆分 → 每片段一行 ---- */
function Analyze() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [museReady, setMuseReady] = useState<null | boolean>(null)
  const [rawText, setRawText] = useState('')
  const startedRef = useRef(false)

  useEffect(() => { probeMuseReady().then(setMuseReady) }, [])

  async function runBreakdown() {
    if (!state.source.trimmedId) {
      toast('没有可分析的视频，请先上传并裁剪', { tone: 'warn' })
      dispatch({ type: 'analyzeFailed', err: '没有裁剪片段' })
      return
    }
    dispatch({ type: 'startAnalyze' })
    dispatch({ type: 'analyzeProgress', p: 8 })
    try {
      const r = await breakdownStrategy({ trimmed_id: state.source.trimmedId })
      dispatch({ type: 'analyzeProgress', p: 70 })
      const txt = r?.choices?.[0]?.message?.content ?? r?.data?.choices?.[0]?.message?.content ?? ''
      setRawText(String(txt).slice(0, 6000))
      const parsed = extractJson(String(txt))
      if (parsed && Array.isArray((parsed as any).segments) && (parsed as any).segments.length) {
        dispatch({ type: 'analyzeProgress', p: 100 })
        dispatch({ type: 'setStrategySkill', json: parsed as any })
      } else {
        dispatch({ type: 'analyzeFailed', err: '分析结果格式异常，请重新尝试' })
        toast('分析结果解析失败，可重试', { tone: 'warn' })
      }
    } catch (e: any) {
      const msg = String(e?.message || '未知错误').slice(0, 220)
      const friendly = `整片反推失败：${msg}`
      dispatch({ type: 'analyzeFailed', err: friendly })
      toast(friendly, { tone: 'warn' })
    }
  }

  // museReady 探测到结果后自动触发一次（仅一次）
  useEffect(() => {
    // 历史任务恢复时已经带有策略结果，不能再次自动发起反推并覆盖已保存状态。
    if (state.analyzed || state.analyzing || museReady === null || startedRef.current) return
    startedRef.current = true
    if (museReady) runBreakdown()
    else dispatch({ type: 'analyzeFailed', err: '分析服务未连接，请检查服务配置' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [museReady, state.analyzed, state.analyzing])

  // 分析进行中的假进度推进（服务端进度只有 8/70/100 三档，中间补一点动感）
  useEffect(() => {
    if (!state.analyzing) return
    const t = setInterval(() => {
      dispatch({ type: 'analyzeProgress', p: Math.min(65, state.analyzeProgress + 1.5) })
    }, 220)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.analyzing])

  if (state.analyzeErr && !state.analyzing && !state.analyzed) {
    return (
      <div className="analyze-box">
        <div style={{ width: '100%', maxWidth: 620, marginBottom: 12, padding: '10px 14px', borderRadius: 'var(--r-btn)', background: 'var(--color-warn-soft, oklch(96% 0.05 40))', border: '1px solid var(--color-warn)', color: 'var(--color-warn)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, textAlign: 'left' }}>
          拆镜拉片分析失败：{state.analyzeErr.slice(0, 200)}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn--ghost btn-with-icon" onClick={() => dispatch({ type: 'resetSource' })}><UploadIcon size={15} />重新上传视频</button>
          <button className="btn btn--primary" onClick={runBreakdown}>重试分析 ▸</button>
        </div>
        {rawText && (
          <details style={{ marginTop: 14, width: '100%', maxWidth: 780, textAlign: 'left' }}>
            <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ink-3)' }}>MODEL RAW · {rawText.length} chars</summary>
            <pre style={{ marginTop: 8, padding: 12, background: 'var(--color-paper-2)', border: '1px solid var(--color-rule)', borderRadius: 'var(--r-btn)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55, color: 'var(--color-ink-2)', maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{rawText}</pre>
          </details>
        )}
      </div>
    )
  }
  if (state.analyzing) {
    return (
      <div className="analyze-box">
        <div className="spinner" />
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 17, color: 'var(--color-ink)' }}>正在拆解镜头与成片策略… {Math.round(state.analyzeProgress)}%</div>
        <div className="aprog"><i style={{ ['--p' as any]: state.analyzeProgress / 100 }} /></div>
        <div className="analyze-steps">
          {['观看参考片 · 定位镜头切点', '归纳成片策略 · 卖点/套路/钩子', '产出拆镜时间轴 · 每段口播文案'].map((a, i) => (
            <div key={a} className={`astep ${state.analyzeProgress > (i + 1) * 30 ? 'done' : state.analyzeProgress > i * 30 ? 'run' : ''}`}><span className="ab" />{a}</div>
          ))}
        </div>
      </div>
    )
  }
  if (state.analyzed && state.strategySkill) return <StrategyReport />
  // museReady 还没探测出结果、也还没进入 analyzing/失败态：短暂的探测中占位，避免空白闪一下
  return (
    <div className="analyze-box">
      <div className="spinner" />
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 17, color: 'var(--color-ink)' }}>正在连接分析服务…</div>
    </div>
  )
}

/* ---- 1.0 成片策略 + 拆镜时间轴 + 分镜拆分入口 ---- */
function StrategyReport() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const j = state.strategySkill!
  const [showMd, setShowMd] = useState(false)
  const [activeTab, setActiveTab] = useState<'film' | 'shots'>('film')
  const [selectedSegment, setSelectedSegment] = useState(0)
  const shotRailRef = useRef<HTMLDivElement>(null)
  const asrRepairStarted = useRef(false)
  const [asrRepairing, setAsrRepairing] = useState(false)

  async function repairAsr() {
    if (!state.source.trimmedId || asrRepairing) return
    setAsrRepairing(true)
    try {
      const result = await transcribeVideo({ trimmed_id: state.source.trimmedId })
      if (result.segments?.length) {
        dispatch({ type: 'applyAsrTranscript', segments: result.segments })
        toast(`ASR 已识别 ${result.segments.length} 段口播（含画外音）`)
      } else toast('音轨中未识别到清晰人声，可点击重新识别', { tone: 'warn' })
    } catch (e: any) {
      toast(`ASR 识别失败：${String(e?.message || e).slice(0, 100)}`, { tone: 'warn' })
    } finally {
      setAsrRepairing(false)
    }
  }

  useEffect(() => {
    if (asrRepairStarted.current || !state.source.trimmedId || j.segments.some(seg => seg.asr_text?.trim())) return
    asrRepairStarted.current = true
    repairAsr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.source.trimmedId])
  const hooks = j.strategy?.attention_hooks || { pre_roll: '', mid_roll: '', end_roll: '' }
  const analysisCards = [
    { key: 'selling', label: '核心卖点', kicker: 'VALUE PROPOSITION', value: j.strategy?.core_selling_point || '—', tone: 'blue' },
    { key: 'expression', label: '表达方式', kicker: 'EXPRESSION STYLE', value: j.strategy?.expression_style || '—', tone: 'purple' },
    { key: 'logic', label: '镜头组织', kicker: 'SHOT LOGIC', value: j.strategy?.shot_logic || '—', tone: 'teal' },
    { key: 'narrative', label: '叙事结构', kicker: 'NARRATIVE ARC', value: j.strategy?.narrative_structure || '—', tone: 'amber' },
  ]

  return (
    <div className="strategy-report">
      <ShotSplitControl auto silent />
      <div className="strat-head strategy-report__head">
        <span className="strat-bar" />
        <div>
          <div className="strat-title">整片反推完成 · {j.meta?.title}</div>
          <div className="strat-sub">{j.meta?.segment_count ?? j.segments.length} 段 · 共 {j.meta?.total_duration_s}s · 套路：{j.meta?.routine}</div>
        </div>
        <div className="strategy-head-actions"><button className="btn btn--ghost btn--sm btn-with-icon" onClick={repairAsr} disabled={asrRepairing}>{!asrRepairing && <RotateCcw size={14} />}{asrRepairing ? '识别口播中…' : '重新识别口播'}</button><button className="btn btn--ghost btn--sm strategy-reupload btn-with-icon" onClick={() => { if (window.confirm('重新上传会清空当前反推、拆镜和生成结果，是否继续？')) dispatch({ type: 'resetSource' }) }}><UploadIcon size={14} />重新上传视频</button></div>
      </div>

      <div className="strategy-tabs" role="tablist" aria-label="反推结果视图">
        <button role="tab" aria-selected={activeTab === 'film'} className={`strategy-tab ${activeTab === 'film' ? 'is-active' : ''}`} onClick={() => setActiveTab('film')}><span>01</span>成片分析</button>
        <button role="tab" aria-selected={activeTab === 'shots'} className={`strategy-tab ${activeTab === 'shots' ? 'is-active' : ''}`} onClick={() => setActiveTab('shots')}><span>02</span>自然拆镜 <em>{j.segments.length} 段</em></button>
        <button className="strategy-md-toggle" onClick={() => setShowMd(v => !v)}>{showMd ? '收起' : '查看'} 完整 md</button>
      </div>
      {showMd && <pre className="strategy-md">{state.strategyMd}</pre>}

      {activeTab === 'film' ? (
        <section className="strategy-panel" aria-label="成片分析">
          <div className="strategy-panel__intro"><div><span className="strategy-eyebrow">FILM ANALYSIS</span><h3>成片分析</h3></div><p>先读懂这条片的卖点、叙事与注意力设计，再把它转化为可复刻的表达逻辑。</p></div>
          <div className="analysis-card-grid">
            {analysisCards.map(card => <article key={card.key} className={`analysis-card analysis-card--${card.tone}`}><span className="analysis-card__kicker">{card.kicker}</span><h4>{card.label}</h4><p>{card.value}</p></article>)}
          </div>
          <section className="hook-card"><div className="hook-card__head"><span className="strategy-eyebrow">ATTENTION SYSTEM</span><h3>吸睛钩子</h3><p>从开头留人，到中段维持注意力，再到结尾推动行动。</p></div><div className="hook-grid"><article><span className="hook-step">前贴 · 0–3s</span><h4>开场钩子</h4><p>{hooks.pre_roll || '—'}</p></article><article><span className="hook-step">中插 · 保持观看</span><h4>注意力转折</h4><p>{hooks.mid_roll || '—'}</p></article><article><span className="hook-step">尾贴 · 行动召唤</span><h4>转化收束</h4><p>{hooks.end_roll || '—'}</p></article></div></section>
          <section className="remake-card"><div className="remake-card__head"><span className="strategy-eyebrow">REMAKE BLUEPRINT</span><h3>复刻蓝图</h3></div><div className="remake-card__grid"><div><h4>不可丢锚点</h4><p>{(j.remake?.anchors || []).join(' / ') || '—'}</p></div><div><h4>可替换变量</h4><p>{(j.remake?.variables || []).join(' / ') || '—'}</p></div><div><h4>制作建议</h4><p>{(j.remake?.production_tips || []).join(' / ') || '—'}</p></div><div><h4>注意事项</h4><p>{(j.remake?.cautions || []).join(' / ') || '—'}</p></div></div></section>
        </section>
      ) : (
        <section className="strategy-panel strategy-shot-workspace" aria-label="自然拆镜">
          <div className="strategy-panel__intro"><div><span className="strategy-eyebrow">NATURAL SHOT BREAKDOWN</span><h3>自然拆镜</h3></div><p>以画面与 ASR 的突变判断边界。一个任务可以包含多个连续切镜，优先保持完整叙事。</p></div>
          {(() => {
            const seg = j.segments[Math.min(selectedSegment, j.segments.length - 1)]
            const shot = state.shots[selectedSegment]
            const splitLabel = shot?.splitStatus === 'done' ? '原片已拆分' : shot?.splitStatus === 'failed' ? '拆分失败' : shot?.splitStatus === 'running' ? '拆分中' : '待拆分'
            const moveRail = (direction: -1 | 1) => shotRailRef.current?.scrollBy({ left: direction * 360, behavior: 'smooth' })
            return <><div className="shot-focus"><div className="shot-focus__media"><span className="shot-focus__id">S{selectedSegment + 1}</span>{shot?.shotTrimmedId ? <video src={videoPreviewUrl(shot.shotTrimmedId)} controls playsInline preload="metadata" /> : <div className="shot-focus__placeholder">原片切片段</div>}</div><div className="shot-focus__detail"><div className="shot-focus__meta"><span className={`strategy-role-badge strategy-role-${seg.role}`}>{ROLE[seg.role] || seg.role}</span><span className="shot-focus__data">{seg.start}–{seg.end} · {seg.duration}s</span><span className="shot-focus__data">{seg.on_screen_text?.length ? '有字幕' : '无字幕'}</span><span className={`st-chip ${shot?.splitStatus === 'done' ? 'st-done' : shot?.splitStatus === 'failed' ? 'st-fail' : ''}`}><span className="st-dot" />{splitLabel}</span></div><div className="shot-focus__fields"><section><h4>ASR 原文 / 默认口播</h4><p className="strategy-shot-card__voice">{seg.asr_text || '无可识别口播'}</p></section><section><h4>画面</h4><p>{seg.visual || '—'}</p></section><section><h4>动作与运镜</h4><p>{seg.action || '—'}{seg.camera ? ` · ${seg.camera}` : ''}</p></section><section><h4>原片信息</h4><p>{seg.source_audio || '无原声描述'}{seg.on_screen_text?.length ? ` · 字幕：${seg.on_screen_text.join(' / ')}` : ''}</p></section><section><h4>本段作用</h4><p>{seg.role_note || '—'}</p></section></div>{shot?.splitError && <div className="rep-error">{shot.splitError}</div>}</div></div><div className="shot-thumb-rail"><button className="shot-rail-arrow shot-rail-arrow--left" aria-label="向左滑动缩略图" onClick={() => moveRail(-1)}>‹</button><div className="shot-carousel" ref={shotRailRef}>{j.segments.map((item, i) => { const itemShot = state.shots[i]; const src = itemShot?.shotTrimmedId ? videoPreviewUrl(itemShot.shotTrimmedId) : null; return <button key={`${item.index}-${item.start}`} className={`shot-carousel__item ${selectedSegment === i ? 'is-active' : ''}`} onClick={() => setSelectedSegment(i)}><div className="shot-carousel__media">{src ? <video src={src} muted playsInline preload="metadata" /> : <span>原片缩略图</span>}<b>S{i + 1}</b></div><div className="shot-carousel__meta"><strong>{ROLE[item.role] || item.role}</strong><em>{item.start}–{item.end}</em></div></button>})}</div><button className="shot-rail-arrow shot-rail-arrow--right" aria-label="向右滑动缩略图" onClick={() => moveRail(1)}>›</button></div></>
          })()}
        </section>
      )}
    </div>
  )
}
