import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react'
import type { AppState, Shot, ShotDuration, ShotAspect, AudioClip, CoverOpt, TitleOpt, StrategySkillJson } from './types'
import { buildStrategySkillMd, mmssToSec } from './lib/strategySkill'

const uid = () => Math.random().toString(36).slice(2, 9)

function removeAdjacentVoiceoverDuplicates<T extends { asr_text?: string; voiceover_script: string }>(segments: T[]): T[] {
  const result = segments.map(seg => ({ ...seg }))
  for (let i = 1; i < result.length; i++) {
    const previous = String(result[i - 1].asr_text || '').trim().replace(/[，。！？；：,.!?]+$/g, '')
    let current = String(result[i].asr_text || '').trim().replace(/^[，。！？；：,.!?]+/g, '')
    let overlap = 0
    for (let size = Math.min(previous.length, current.length); size >= 4; size--) {
      if (previous.slice(-size) === current.slice(0, size)) { overlap = size; break }
    }
    if (!overlap) continue
    current = current.slice(overlap).replace(/^[，。！？；：,.!?\s]+/g, '')
    const cleaned = current && !/[。！？!?]$/.test(current) ? `${current}。` : current
    result[i] = { ...result[i], asr_text: cleaned, voiceover_script: cleaned }
  }
  return result
}

// 把任意秒数吸附到最近的档位（5/10/15s）——生成时长只允许这三档，与画幅一起提交给模型
export function snapToShotDuration(sec: number): ShotDuration {
  const opts: ShotDuration[] = [5, 10, 15]
  return opts.reduce((best, o) => Math.abs(o - sec) < Math.abs(best - sec) ? o : best, opts[0])
}

export const initialState: AppState = {
  taskName: '未命名任务',
  productRefs: [],
  batch: { mode: 'idle', queueIds: [] },
  step: 0,
  source: { name: '', sizeMB: 0, durationS: 0, resolution: '', objectUrl: null as string | null, rawId: '', trimmedId: '' },
  crop: { enabled: false, start: 0, end: 0 },

  analyzing: false, analyzeProgress: 0, analyzed: false, analyzeErr: '',
  strategySkill: null, strategyMd: '',

  splitting: false, shots: [],

  compose: { audios: [], subs: [], subtitleOn: true, renderStatus: 'idle' },
  covers: [], titles: [],
  cover: 0, title: 0, toast: null,
}

export type Action =
  | { type: 'hydrateTask'; state: AppState; taskId: string; taskName: string }
  | { type: 'setTaskName'; name: string }
  | { type: 'setProductRefs'; refs: AppState['productRefs'] }
  | { type: 'addProductRefs'; refs: AppState['productRefs'] }
  | { type: 'delProductRef'; refId: string }
  | { type: 'startBatch'; mode: 'analyze' | 'generate'; queueIds: string[] }
  | { type: 'setBatchCurrent'; id?: string }
  | { type: 'stopBatch' }
  | { type: 'finishBatch' }
  | { type: 'goStep'; step: number }
  | { type: 'setNewSource'; source: Partial<AppState['source']> }
  | { type: 'patchSource'; source: Partial<AppState['source']> }
  | { type: 'resetSource' }
  | { type: 'setCrop'; crop: Partial<AppState['crop']> }
  // 1.0 · 拆镜拉片专家
  | { type: 'startAnalyze' }
  | { type: 'analyzeProgress'; p: number }
  | { type: 'analyzeFailed'; err: string }
  | { type: 'setStrategySkill'; json: StrategySkillJson }
  | { type: 'applyAsrTranscript'; segments: { start: number; end: number; text: string }[] }
  // 1.0 末尾 / 2.0 开头 · 共用分镜拆分
  | { type: 'startSplit' }
  | { type: 'completeSplit'; results: { id: string; ok: boolean; shotTrimmedId?: string; error?: string }[] }
  | { type: 'failSplit'; err: string }
  | { type: 'setShots'; shots: Shot[] }
  // 2.0 · 每段分析（视频技能创作专家）
  | { type: 'startShotAnalyze'; id: string }
  | { type: 'failShotAnalyze'; id: string; err: string; rawMd?: string }
  | { type: 'setShotAnalyzeMd'; id: string; md: string; prompt: string; requiresImage?: boolean }
  // 2.0 · 每段编辑/生成
  | { type: 'editShot'; id: string; patch: Partial<Shot> }
  | { type: 'addShotRef'; id: string; ref: { id: string; url: string; name: string } }
  | { type: 'delShotRef'; id: string; refId: string }
  | { type: 'genShot'; id: string; progress: number; status?: Shot['status']; patch?: Partial<Shot> }
  | { type: 'genAllStart' }
  // 3.0 视频处理：逐分镜擦除
  | { type: 'toggleErase'; id: string }
  | { type: 'setErased'; id: string; erased: boolean }
  | { type: 'setProcessedVideo'; id: string; url: string; erased: boolean }
  | { type: 'setProcessError'; id: string; err?: string }
  // 4.0 轨道编辑
  | { type: 'moveShot'; id: string; dir: -1 | 1 }
  | { type: 'reorderShots'; from: number; to: number }
  | { type: 'addAudio'; clip: AudioClip }
  | { type: 'toggleAudioTrack'; id: string }
  | { type: 'delAudio'; id: string }
  | { type: 'editAudio'; id: string; patch: Partial<AudioClip> }
  | { type: 'editSub'; id: string; patch: Partial<AppState['compose']['subs'][number]> }
  | { type: 'addSub' }
  | { type: 'delSub'; id: string }
  | { type: 'toggleSubtitle' }
  | { type: 'setRenderStatus'; status: AppState['compose']['renderStatus']; url?: string; err?: string }
  // 5.0 封面/标题 AI 生成
  | { type: 'addCover'; cover: CoverOpt }
  | { type: 'addTitle'; title: TitleOpt }
  | { type: 'setCover'; i: number }
  | { type: 'setTitle'; i: number }
  | { type: 'toast'; toast: import('./types').Toast | null }

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'hydrateTask': {
      // 浏览器刷新或服务重启后，旧的 running/queued 没有可恢复的前端轮询句柄；
      // 解除假运行状态，让用户可以重新提交，而不是永久卡在 2%。
      const hydrated = { ...initialState, ...a.state, taskId: a.taskId, taskName: a.taskName, toast: null, batch: { mode: 'idle', queueIds: [] } } as AppState
      hydrated.shots = (hydrated.shots || []).map(sh => ({
        ...sh,
        generatedDuration: sh.generatedDuration || (sh.videoUrl ? sh.genDuration : undefined),
        trimStart: sh.videoUrl && !sh.generatedDuration ? 0 : sh.trimStart,
        trimEnd: sh.videoUrl && !sh.generatedDuration ? sh.genDuration : sh.trimEnd,
        analyzeStatus: sh.analyzeStatus === 'running' ? 'failed' : sh.analyzeStatus,
        analyzeError: sh.analyzeStatus === 'running' ? '上次分析已中断，请重新提交' : sh.analyzeError,
        status: sh.status === 'running' || sh.status === 'queued' ? 'failed' : sh.status,
        progress: sh.status === 'running' || sh.status === 'queued' ? 0 : sh.progress,
        generationError: sh.status === 'running' || sh.status === 'queued' ? '上次生成轮询已中断，请重新提交' : sh.generationError,
      }))
      return hydrated
    }
    case 'setTaskName': return { ...s, taskName: a.name.slice(0, 80) || '未命名任务' }
    case 'setProductRefs': return { ...s, productRefs: a.refs.slice(0, 9) }
    case 'addProductRefs': return { ...s, productRefs: [...s.productRefs, ...a.refs].slice(0, 9) }
    case 'delProductRef': return { ...s, productRefs: s.productRefs.filter(ref => ref.id !== a.refId) }
    case 'startBatch': return { ...s, batch: { mode: a.mode, queueIds: a.queueIds, currentId: undefined } }
    case 'setBatchCurrent': return { ...s, batch: { ...s.batch, currentId: a.id } }
    case 'stopBatch': return { ...s, batch: { ...s.batch, stopped: true } }
    case 'finishBatch': return { ...s, batch: { mode: 'idle', queueIds: [] } }
    case 'goStep': return { ...s, step: a.step }
    case 'setNewSource': {
      // 真正换源时才初始化裁剪区间并清空旧策略/分镜/复刻结果；后续仅补写 rawId/trimmedId
      // 必须走 patchSource，避免把用户已经选好的裁剪范围重置成 0..原片时长。
      if (s.source.objectUrl && s.source.objectUrl.startsWith('blob:') && s.source.objectUrl !== a.source.objectUrl) {
        try { URL.revokeObjectURL(s.source.objectUrl) } catch {}
      }
      const source = { ...initialState.source, ...a.source }
      const end = Math.min(source.durationS || 45, 180)
      return { ...initialState, taskId: s.taskId, taskName: s.taskName, productRefs: s.productRefs, source, crop: { enabled: true, start: 0, end } }
    }
    case 'patchSource': return { ...s, source: { ...s.source, ...a.source } }
    case 'resetSource': {
      // 清空/重新上传：回到无视频态，重置整条链路（分析/分镜/生成全部作废，避免残留旧结果）
      if (s.source.objectUrl && s.source.objectUrl.startsWith('blob:')) { try { URL.revokeObjectURL(s.source.objectUrl) } catch {} }
      return { ...initialState, taskId: s.taskId, taskName: s.taskName, productRefs: s.productRefs }
    }
    case 'setCrop': return { ...s, crop: { ...s.crop, ...a.crop } }

    case 'startAnalyze': return { ...s, analyzing: true, analyzeProgress: 0, analyzed: false, analyzeErr: '' }
    case 'analyzeProgress': return { ...s, analyzeProgress: a.p }
    case 'analyzeFailed': return { ...s, analyzing: false, analyzed: false, analyzeProgress: 0, analyzeErr: a.err }
    case 'setStrategySkill': {
      const md = buildStrategySkillMd(a.json)
      // 用策略skill 的 segments 直接铺出分镜行；这里先让用户看到时间轴，小视频由
      // 1.0 末尾或 2.0 开头共用的 ShotSplitControl 调 ffmpeg 拆分。
      const shots: Shot[] = a.json.segments.map((seg, i) => ({
        id: uid(),
        no: `S${i + 1}`,
        range: `${seg.start}–${seg.end}`,
        sourceStart: mmssToSec(seg.start),
        sourceEnd: mmssToSec(seg.end),
        role: seg.role,
        roleNote: seg.role_note,
        visualHint: seg.visual,
        duration: seg.duration,
        splitStatus: 'idle',
        analyzeStatus: 'idle',
        prompt: seg.visual,
        // ASR 原文优先且直接进入逐镜生成；voiceover_script 仅兼容旧任务数据。
        voiceover: String(seg.asr_text || seg.voiceover_script || ''),
        genDuration: snapToShotDuration(seg.duration),
        aspectRatio: (a.json.meta?.aspect === '16:9' ? '16:9' : '9:16') as ShotAspect,
        requiresImage: false,
        refs: [],
        status: 'idle', progress: 0,
        eraseOn: true, erased: false,
        trimStart: 0, trimEnd: seg.duration, speed: 1,
      }))
      return {
        ...s,
        analyzing: false, analyzed: true, analyzeProgress: 100, analyzeErr: '',
        strategySkill: a.json, strategyMd: md,
        shots,
      }
    }

    case 'applyAsrTranscript': {
      if (!s.strategySkill || !a.segments.length) return s
      const strategySkill = {
        ...s.strategySkill,
        segments: removeAdjacentVoiceoverDuplicates(s.strategySkill.segments.map((seg, segIndex) => {
          const start = mmssToSec(seg.start)
          const end = mmssToSec(seg.end)
          const exact = a.segments
            // 跨镜头的 ASR 时间片按中心点唯一归属，避免前后两段重复同一句。
            .filter(row => {
              const midpoint = (row.start + row.end) / 2
              return midpoint >= start && (midpoint < end || (segIndex === s.strategySkill!.segments.length - 1 && midpoint <= end))
            })
            .map(row => row.text.trim().replace(/[，。！？；：,.!?]+$/g, ''))
            .filter(Boolean)
            .join('，')
            .replace(/，{2,}/g, '，')
            .replace(/，$/g, '')
            .trim()
          const punctuated = exact && !/[。！？!?]$/.test(exact) ? `${exact}。` : exact
          return { ...seg, asr_text: punctuated, voiceover_script: punctuated }
        })),
      }
      return {
        ...s,
        strategySkill,
        strategyMd: buildStrategySkillMd(strategySkill),
        shots: s.shots.map((shot, i) => {
          const exact = strategySkill.segments[i]?.asr_text?.trim() || ''
          return { ...shot, voiceover: exact }
        }),
      }
    }

    case 'startSplit': return {
      ...s,
      splitting: true,
      shots: s.shots.map(sh => ({
        ...sh,
        splitStatus: 'running', splitError: undefined, shotTrimmedId: undefined,
        analyzeStatus: 'idle', analyzeError: undefined, analyzeMd: undefined,
        status: 'idle', progress: 0, videoUrl: undefined, isMock: undefined,
      })),
    }
    case 'completeSplit': {
      const byId = new Map(a.results.map(r => [r.id, r]))
      return {
        ...s,
        splitting: false,
        shots: s.shots.map(sh => {
          const r = byId.get(sh.id)
          if (!r) return { ...sh, splitStatus: 'failed', splitError: '拆分结果缺失', shotTrimmedId: undefined }
          return r.ok
            ? { ...sh, splitStatus: 'done', splitError: undefined, shotTrimmedId: r.shotTrimmedId }
            : { ...sh, splitStatus: 'failed', splitError: r.error || '分镜拆分失败', shotTrimmedId: undefined }
        }),
      }
    }
    case 'failSplit': return {
      ...s,
      splitting: false,
      shots: s.shots.map(sh => ({ ...sh, splitStatus: 'failed', splitError: a.err, shotTrimmedId: undefined })),
    }
    case 'setShots': return { ...s, shots: a.shots }

    case 'startShotAnalyze': return {
      ...s,
      shots: s.shots.map(sh => sh.id === a.id
        ? { ...sh, analyzeStatus: 'running', analyzeError: undefined, analyzeMd: undefined }
        : sh),
    }
    case 'failShotAnalyze': return {
      ...s,
      shots: s.shots.map(sh => sh.id === a.id
        ? { ...sh, analyzeStatus: 'failed', analyzeError: a.err, analyzeMd: a.rawMd || sh.analyzeMd }
        : sh),
    }
    case 'setShotAnalyzeMd': return {
      ...s, shots: s.shots.map(sh => sh.id === a.id
        ? { ...sh, analyzeMd: a.md, analyzeStatus: 'done', analyzeError: undefined, prompt: a.prompt, requiresImage: a.requiresImage ?? sh.requiresImage }
        : sh),
    }

    case 'editShot': return { ...s, shots: s.shots.map(sh => sh.id === a.id ? { ...sh, ...a.patch } : sh) }
    case 'addShotRef': {
      return { ...s, shots: s.shots.map(sh => sh.id === a.id && sh.refs.length < 9 ? { ...sh, refs: [...sh.refs, a.ref], requiresImage: true } : sh) }
    }
    case 'delShotRef': return { ...s, shots: s.shots.map(sh => { if (sh.id !== a.id) return sh; const refs = sh.refs.filter(r => r.id !== a.refId); return { ...sh, refs, requiresImage: refs.length > 0 } }) }
    case 'genShot': return { ...s, shots: s.shots.map(sh => sh.id === a.id ? { ...sh, ...(a.patch || {}), progress: a.progress, status: a.status ?? sh.status } : sh) }
    case 'genAllStart': return { ...s, shots: s.shots.map(sh => ({ ...sh, status: 'queued', progress: 0 })) }

    // 3.0 逐分镜擦除：保留原 videoUrl，处理结果单独落在 processedVideoUrl，方便同页对照。
    case 'toggleErase': return { ...s, shots: s.shots.map(sh => sh.id === a.id ? { ...sh, eraseOn: !sh.eraseOn, erased: false, processError: undefined } : sh) }
    case 'setErased': return { ...s, shots: s.shots.map(sh => sh.id === a.id ? { ...sh, erased: a.erased } : sh) }
    case 'setProcessedVideo': return { ...s, shots: s.shots.map(sh => sh.id === a.id ? { ...sh, processedVideoUrl: a.url, erased: a.erased, processError: undefined } : sh) }
    case 'setProcessError': return { ...s, shots: s.shots.map(sh => sh.id === a.id ? { ...sh, processError: a.err } : sh) }

    // 4.0 轨道：排序 / 音频 / 字幕
    case 'moveShot': {
      const i = s.shots.findIndex(sh => sh.id === a.id); const j = i + a.dir
      if (i < 0 || j < 0 || j >= s.shots.length) return s
      const arr = [...s.shots];[arr[i], arr[j]] = [arr[j], arr[i]]
      return { ...s, shots: arr }
    }
    case 'reorderShots': {
      const { from, to } = a
      if (from === to || from < 0 || to < 0 || from >= s.shots.length || to >= s.shots.length) return s
      const arr = [...s.shots]; const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved)
      return { ...s, shots: arr }
    }
    case 'addAudio': return { ...s, compose: { ...s.compose, audios: [...s.compose.audios, a.clip] } }
    case 'toggleAudioTrack': return { ...s, compose: { ...s.compose, audios: s.compose.audios.map(c => c.id === a.id ? { ...c, inTrack: !c.inTrack } : c) } }
    case 'delAudio': return { ...s, compose: { ...s.compose, audios: s.compose.audios.filter(c => c.id !== a.id) } }
    case 'editAudio': return { ...s, compose: { ...s.compose, audios: s.compose.audios.map(c => c.id === a.id ? { ...c, ...a.patch } : c) } }
    case 'editSub': return { ...s, compose: { ...s.compose, subs: s.compose.subs.map(sub => sub.id === a.id ? { ...sub, ...a.patch } : sub) } }
    case 'addSub': {
      const last = s.compose.subs[s.compose.subs.length - 1]
      const start = last ? last.end : 0
      const end = Math.min(totalShotsDuration(s), start + 5)
      return { ...s, compose: { ...s.compose, subs: [...s.compose.subs, { id: uid(), start, end, text: '新字幕' }] } }
    }
    case 'delSub': return { ...s, compose: { ...s.compose, subs: s.compose.subs.filter(sub => sub.id !== a.id) } }
    case 'toggleSubtitle': return { ...s, compose: { ...s.compose, subtitleOn: !s.compose.subtitleOn } }
    case 'setRenderStatus': return { ...s, compose: { ...s.compose, renderStatus: a.status, renderedVideoUrl: a.url ?? s.compose.renderedVideoUrl, renderError: a.err } }
    // 5.0 封面/标题 AI 生成
    case 'addCover': return { ...s, covers: [...s.covers, a.cover], cover: s.covers.length }
    case 'addTitle': return { ...s, titles: [...s.titles, a.title], title: s.titles.length }
    case 'setCover': return { ...s, cover: a.i }
    case 'setTitle': return { ...s, title: a.i }
    case 'toast': return { ...s, toast: a.toast }
    default: return s
  }
}

function totalShotsDuration(s: AppState): number {
  return s.shots.reduce((sum, sh) => sum + Math.max(0.1, (sh.trimEnd - sh.trimStart) / sh.speed), 0)
}

const Ctx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>
}

export function useStore() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useStore must be inside StoreProvider')
  return c
}

// silent-success toast + optional undo
// 用法：
//   toast('已删除')                                  -> 纯提示 1.9s
//   toast('已删除', { undo: () => 复原 })            -> 附带撤销，5s
//   toast('失败原因', { tone: 'warn' })              -> 警告色
let toastTimer: ReturnType<typeof setTimeout>
const undoRegistry = new Map<string, () => void>()

export function runToastUndo(id: string) {
  const fn = undoRegistry.get(id)
  if (fn) { fn(); undoRegistry.delete(id) }
}

export function useToast() {
  const { dispatch } = useStore()
  return (msg: string, opts?: { undo?: () => void; tone?: 'info' | 'warn' }) => {
    let undoId: string | undefined
    if (opts?.undo) {
      undoId = 'u_' + Math.random().toString(36).slice(2, 8)
      undoRegistry.set(undoId, opts.undo)
    }
    dispatch({ type: 'toast', toast: { msg, tone: opts?.tone ?? 'info', undoId } })
    clearTimeout(toastTimer)
    const dur = opts?.undo ? 5000 : 1900
    toastTimer = setTimeout(() => {
      if (undoId) undoRegistry.delete(undoId)
      dispatch({ type: 'toast', toast: null })
    }, dur)
  }
}

export const STEPS = [
  { no: '1.0', nm: '视频反推', code: 'REVERSE' },
  { no: '2.0', nm: '视频复刻', code: 'REPLICATE' },
  { no: '3.0', nm: '视频处理', code: 'PROCESS', opt: true },
  { no: '4.0', nm: '合成成片', code: 'COMPOSE' },
  { no: '5.0', nm: '封面标题', code: 'COVER' },
]

export const ROLE: Record<string, string> = { hook: '钩子', point: '卖点', demo: '演示', transition: '转场', proof: '背书', cta: 'CTA' }

// 「当前实际处理时长」：裁剪生效时用裁剪跨度，否则用原片 durationS。
// 全项目该展示"当前视频时长"的地方统一用它，而不是散读 source.durationS
// （那是原片时长，裁剪后已经不代表实际分析/生产的片段）。
export function effectiveDuration(state: AppState): number {
  const { crop, source } = state
  if (crop.enabled && crop.end > crop.start) return +(crop.end - crop.start).toFixed(1)
  return source.durationS
}
