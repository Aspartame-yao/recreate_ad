// 五步链路（2026-07-17）：
//   1.0 视频反推 —— 上传/裁剪 → 整片拆镜与成片策略 → 分镜拆分（入口一）
//   2.0 视频复刻 —— 分镜拆分（入口二）→ 每片段反推 skill → 编辑参数/口播 → 有声视频生成
//   3.0 视频处理 —— 字幕擦除（可选）
//   4.0 合成成片 —— 轨道编辑
//   5.0 封面标题 —— AI 生成

export interface SourceVideo {
  name: string
  sizeMB: number
  durationS: number
  resolution: string
  objectUrl: string | null   // 上传后的可播放 URL
  rawId?: string             // 服务端缓存的原视频 id（上传/URL导入后拿到）
  trimmedId?: string         // 服务端 ffmpeg 裁剪后的小片段 id（分析/分镜拆分时的源）
}

export interface Crop { enabled: boolean; start: number; end: number }

// —— 拆镜拉片专家产出的《策略skill》结构化 JSON（严格对应 breakdown-strategy 接口返回）——
export interface StrategySegment {
  index: number
  start: string   // mm:ss（相对分析源片，即裁剪片段自身的 0 起算）
  end: string     // mm:ss
  duration: number  // 自然拆镜时长；5/10/15 仅用于后续生成建议
  role: 'hook' | 'point' | 'demo' | 'transition' | 'proof' | 'cta'
  visual: string
  action: string
  camera: string
  on_screen_text: string[]
  source_audio: string
  asr_text?: string            // ASR 逐字转写；有口播时作为默认生成口播的唯一来源
  voiceover_script: string
  role_note: string
  merge_reason: string
}
export interface StrategySkillJson {
  meta: {
    title: string; total_duration_s: number; aspect: string; routine: string
    segment_count: number; disclaimer: string
  }
  strategy: {
    core_selling_point: string; expression_style: string; shot_logic: string
    narrative_structure: string
    attention_hooks: { pre_roll: string; mid_roll: string; end_roll: string }
  }
  segments: StrategySegment[]
  remake: { anchors: string[]; variables: string[]; production_tips: string[]; cautions: string[] }
}

// 分镜原片片段（由「分镜拆分」按策略skill的 segments 切出）+ 单段分析 + 生成状态
export type ShotStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed'
export type SplitStatus = 'idle' | 'running' | 'done' | 'failed'
export type AnalyzeStatus = 'idle' | 'running' | 'done' | 'failed'
export interface RefImage { id: string; url: string; name: string; publicUrl?: string }
export interface BatchState { mode: 'idle' | 'analyze' | 'generate'; queueIds: string[]; currentId?: string; stopped?: boolean }
export type ShotDuration = 5 | 10 | 15
export type ShotAspect = '9:16' | '16:9'
export interface Shot {
  id: string
  no: string                     // S1/S2...
  range: string                  // mm:ss–mm:ss（展示用）
  sourceStart: number            // 相对分析源片（裁剪片段）的起点秒，供分镜拆分调用 ffmpeg
  sourceEnd: number               // 相对分析源片的终点秒
  role: StrategySegment['role']
  roleNote: string                // 本段在整片承担什么（segment.role_note）
  visualHint: string               // 策略skill 对本段画面的描述（segment.visual，兜底 prompt）
  duration: number                 // 分镜原始时长（策略skill segment.duration，仅展示/参考）

  // 分镜拆分产出（1.0 末尾与 2.0 开头共用同一状态）
  shotTrimmedId?: string          // 服务端小视频 id（本段原片片段，可播放/送分析）
  splitStatus: SplitStatus
  splitError?: string

  // 2.0「分析片段」（视频技能创作专家）
  analyzeMd?: string               // 完整 .skill.md 全文
  analyzeStatus: AnalyzeStatus
  analyzeError?: string

  // 生成参数（可编辑）
  prompt: string                  // 画面 prompt：分析片段成功后取 visual_prompt，否则回退 visualHint
  voiceover: string                // 口播：默认取策略skill 的 voiceover_script，可编辑
  genDuration: ShotDuration
  aspectRatio: ShotAspect
  requiresImage: boolean
  refs: RefImage[]                 // 参考图，上限 9

  // 生成结果
  status: ShotStatus
  progress: number
  videoUrl?: string
  generatedDuration?: number
  generationError?: string
  isMock?: boolean

  // 3.0 视频处理：保留复刻原料视频，并单独记录处理后的输出
  eraseOn: boolean
  erased: boolean
  processedVideoUrl?: string
  processError?: string
  // 4.0 合成轨道：裁剪 / 变速
  trimStart: number
  trimEnd: number
  speed: number
}

// 4.0 音频轨条目（上传或生成）
export interface AudioClip {
  id: string
  name: string
  source: 'upload' | 'generate'
  duration: number
  url: string | null
  inTrack: boolean     // 是否已加入剪辑轨道
  start: number        // 在音轨上的起始时间（秒），支持拖动
  trimStart: number    // 裁剪起点（秒）
  trimEnd: number      // 裁剪终点（秒）
}

// 字幕轨条目
export interface SubClip { id: string; start: number; end: number; text: string }

export interface Compose {
  audios: AudioClip[]
  subs: SubClip[]
  subtitleOn: boolean   // 字幕总开关：打开则跟随音频轨文字
  renderedVideoUrl?: string
  renderStatus: 'idle' | 'running' | 'done' | 'failed'
  renderError?: string
}

// 封面候选（抽帧 or AI 生成）
export interface CoverOpt { id: string; label: string; kind: 'frame' | 'ai'; url: string | null; aspect?: '9:16' | '16:9' }
export interface TitleOpt { id: string; text: string; tag: string; ai?: boolean }

export interface AppState {
  taskId?: string
  taskName: string
  productRefs: RefImage[]  // 应用于每个复刻任务的统一商品参考图
  batch: BatchState
  step: number             // 0..4 -> 1.0..5.0
  source: SourceVideo
  crop: Crop

  // 1.0 · 拆镜拉片专家
  analyzing: boolean        // 「开始分析」进行中
  analyzeProgress: number   // 0-100
  analyzed: boolean         // 已拿到策略skill
  analyzeErr: string        // 分析失败原因（非空则展示重试）
  strategySkill: StrategySkillJson | null
  strategyMd: string        // strategySkill 渲染成的 SKILL.md 文本（展示用）

  // 1.0 末尾 / 2.0 开头共用分镜拆分；逐镜分析/生成属于 2.0
  splitting: boolean
  shots: Shot[]

  compose: Compose         // 4.0 合成轨道：音频/字幕
  covers: CoverOpt[]       // 5.0 封面候选
  titles: TitleOpt[]       // 5.0 标题候选
  cover: number            // 选中封面 index
  title: number            // 选中标题 index
  toast: Toast | null
}

// silent-success toast：默认无 icon、无 "已"，附带一个可选 undo 动作
export interface Toast {
  msg: string
  tone?: 'info' | 'warn'   // 默认 info（无强色）
  undoId?: string          // 存在则渲染 "撤销" 按钮，点击时通过 dispatch undo:runToastUndo
}
