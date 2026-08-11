// 前端 SDK：统一走同源 /api/muse/*，后端替我们签 X-MUSE-TOKEN
// 部署时可通过 window.__MUSE_API_BASE__ 覆盖为 http://<cvm>:4322

const BASE: string =
  (typeof window !== 'undefined' && (window as any).__MUSE_API_BASE__) || ''

async function post<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, body: data })
  return data as T
}

async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(BASE + path)
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, body: data })
  return data as T
}

// —— 健康检查
export function health() { return get('/api/health') }
export function ping() { return get('/api/muse/ping') }

// 带重试的 muse 就绪探测：单次探测撞上网络抖动/隧道瞬断会把整个会话永久锁在 mock，
// 这里重试 3 次（间隔 1.2s）再判定，大幅降低"其实模型好好的，只是探测那一下抖了"的误判率。
export async function probeMuseReady(retries = 3, intervalMs = 1200): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const h: any = await health()
      const ok = !!(h?.muse && h.muse.client && h.muse.client !== '(未配置)' && h.muse.secret === '已配置')
      if (ok) return true
    } catch { /* 继续重试 */ }
    if (i < retries - 1) await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// —— 1) 视频反推（固定 doubao-seed-2-1-pro-260628，经 MUSE OpenAI-compatible chat）
// name 支持：老 uploads 文件名，或视频缓存 id（raw_id / trimmed_id）——后端统一读盘转 base64 内联
export interface ReverseVideoIn { trimmed_id?: string; video_url?: string; name?: string; prompt?: string; model?: string }
export function reverseVideo(input: ReverseVideoIn) {
  return post<any>('/api/muse/reverse-video', input)
}

// —— 拆镜拉片专家：参考视频 → 策略skill（JSON：拆镜时间轴 + 成片策略），走 chat 兼容响应形状
export interface BreakdownStrategyIn { trimmed_id?: string; video_url?: string; name?: string; model?: string }
export function breakdownStrategy(input: BreakdownStrategyIn) {
  return post<any>('/api/muse/breakdown-strategy', input)
}

export interface AsrSegment { start: number; end: number; text: string }
export async function transcribeVideo(input: { trimmed_id: string }) {
  try {
    return await post<{ ok: boolean; segments: AsrSegment[] }>('/api/asr/transcribe', input)
  } catch (err: any) {
    // 部署滚动切换或旧反向代理尚未刷新时，独立路由可能短暂 404；
    // 回退到已长期存在的整片分析路由，并抽取其中已经由 Whisper 锁定的 ASR。
    if (err?.status !== 404) throw err
    const result = await breakdownStrategy(input)
    const raw = result?.choices?.[0]?.message?.content ?? result?.data?.choices?.[0]?.message?.content ?? ''
    let parsed: any = null
    try { parsed = JSON.parse(String(raw).replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()) } catch {}
    const segments: AsrSegment[] = Array.isArray(parsed?.segments)
      ? parsed.segments.map((seg: any) => ({
          start: clockToSeconds(seg.start),
          end: clockToSeconds(seg.end),
          text: String(seg.asr_text || seg.voiceover_script || '').trim(),
        })).filter((seg: AsrSegment) => seg.text && seg.end > seg.start)
      : []
    return { ok: true, segments }
  }
}

function clockToSeconds(value: unknown) {
  const parts = String(value ?? '').split(':').map(Number)
  return parts.length === 2 && parts.every(Number.isFinite) ? parts[0] * 60 + parts[1] : Number(value) || 0
}

// —— 视频技能创作专家：单个分镜片段 → 完整 .skill.md 文本
export interface AnalyzeShotIn { trimmed_id?: string; video_url?: string; name?: string; model?: string; voiceover_hint?: string }
export function analyzeShot(input: AnalyzeShotIn) {
  return post<any>('/api/muse/analyze-shot', input)
}

// —— 分镜拆分：按策略skill的 segments[{start,end}]（相对 source_id 这条视频自己的秒数）
//    批量 ffmpeg 裁出每段独立小视频，返回每段的 shot_trimmed_id
export interface SplitSegmentsIn { source_id: string; segments: { start: number; end: number }[] }
export interface SplitSegmentsResult { index: number; ok: boolean; shot_trimmed_id?: string; size?: number; duration?: number; error?: string }
export function splitVideoSegments(input: SplitSegmentsIn) {
  return post<{ ok: boolean; results: SplitSegmentsResult[] }>('/api/video/split-segments', input)
}

// ============================================================================
// 服务端 ffmpeg 裁剪流（照搬 aimixer）：上传原视频→raw_id→裁剪→trimmed_id→反推内联
// ============================================================================
export const MAX_RAW_UPLOAD_BYTES = 200 * 1024 * 1024  // 原视频 200MB 上限
export const TRIM_MIN_SEC = 3                          // 裁剪窗口最短
export const TRIM_MAX_SEC = 180                        // 裁剪窗口最长（3~180s）

// 上传本地视频原片（raw body + X-Filename），返回 raw_id。带上传进度回调。
export async function uploadVideoRaw(
  file: Blob,
  opts: { filename?: string; onProgress?: (pct: number) => void } = {},
): Promise<{ raw_id: string; size: number; mime: string; ext: string }> {
  if (file.size > MAX_RAW_UPLOAD_BYTES) {
    throw new Error(`视频 ${(file.size / 1024 / 1024).toFixed(0)}MB 超过 ${(MAX_RAW_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB 上限`)
  }
  const contentType = file.type || 'video/mp4'
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', BASE + '/api/video/upload')
    xhr.setRequestHeader('Content-Type', contentType)
    if (opts.filename) xhr.setRequestHeader('X-Filename', encodeURIComponent(opts.filename))
    xhr.upload.onprogress = e => { if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      let d: any = {}
      try { d = JSON.parse(xhr.responseText) } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && d?.raw_id) resolve(d)
      else reject(Object.assign(new Error(d?.error || `上传失败 HTTP ${xhr.status}`), { status: xhr.status, body: d }))
    }
    xhr.onerror = () => reject(new Error('上传网络错误'))
    xhr.send(file)
  })
}

// 从 blob:URL 读出 Blob 再上传（Step1 本地文件走这条）
export async function uploadVideoRawFromBlobUrl(
  blobUrl: string,
  opts: { filename?: string; onProgress?: (pct: number) => void } = {},
) {
  const blob = await (await fetch(blobUrl)).blob()
  return uploadVideoRaw(blob, opts)
}

// 后端代下载第三方 URL 视频，返回 raw_id（与本地上传后续一致）
export function importVideoUrl(url: string) {
  return post<{ ok: boolean; raw_id: string; size: number; mime: string; ext: string }>('/api/video/import-url', { url })
}

// 服务端 ffmpeg 裁剪：raw_id + [start,end] → trimmed_id（3~120s）
export function trimVideoOnServer(raw_id: string, start: number, end: number) {
  return post<{ ok: boolean; trimmed_id: string; size: number; duration: number }>('/api/video/trim', { raw_id, start, end })
}

// 预览播放地址（支持 Range，可直接喂 <video src>）
export function videoPreviewUrl(id: string) {
  return `${BASE}/api/video/preview/${id}`
}

// 把本地 blob:URL 的视频上传到后端，落盘后拿到公网可访问 URL（供 gemini 网关直接拉取）
// 相比 base64 内联：不撑爆请求体、无 20MB 限制、网关直接按视频 URL 处理
export async function uploadVideo(
  blobUrl: string,
  opts: { onProgress?: (pct: number) => void } = {},
): Promise<{ url: string; bytes: number; name: string }> {
  const resp = await fetch(blobUrl)
  const blob = await resp.blob()
  const contentType = blob.type || 'video/mp4'
  // 用 XHR 以获得上传进度
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', BASE + '/api/upload')
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = e => { if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      let data: any = {}
      try { data = JSON.parse(xhr.responseText) } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.url) resolve({ url: data.url, bytes: data.bytes, name: data.name })
      else reject(new Error(data?.error || `上传失败 HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('上传网络错误'))
    xhr.send(blob)
  })
}

// 把本地 blob:URL / File 读成 base64 data URL，供多模态模型直接消费（gemini 兼容 data: 前缀）
// 返回 { dataUrl, bytes }。超过 sizeLimitMB 抛错，避免请求体过大。
export async function blobUrlToDataUrl(blobUrl: string, sizeLimitMB = 20): Promise<{ dataUrl: string; bytes: number }> {
  const resp = await fetch(blobUrl)
  const blob = await resp.blob()
  const bytes = blob.size
  if (bytes > sizeLimitMB * 1024 * 1024) {
    throw new Error(`视频 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${sizeLimitMB}MB，请先裁剪或压缩后再反推`)
  }
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取本地视频失败'))
    fr.readAsDataURL(blob)
  })
  return { dataUrl, bytes }
}

// —— 2) 文本任务（openai chat 兼容；gpt-5.5 默认）
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: any }
export interface ChatIn {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  response_format?: { type: 'json_object' | 'text' } | any
}
export function chat(input: ChatIn) {
  return post<any>('/api/muse/chat', input)
}

// 便捷：让模型直接吐 JSON
export async function chatJson<T = any>(system: string, user: string, opts: Partial<ChatIn> = {}) {
  const raw = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.6,
    ...opts,
  })
  const txt = raw?.choices?.[0]?.message?.content ?? raw?.data?.choices?.[0]?.message?.content ?? ''
  try { return JSON.parse(txt) as T } catch { return { _raw: txt } as any }
}

// —— 3) 图片生成（seedream）
export interface ImageIn {
  prompt: string
  // Seedream 5.0 Lite 需要像素格式；9:16 需要至少 1440x2560（总像素不低于 3686400）。
  size?: string
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  model?: string
  watermark?: boolean
}
export function generateImage(input: ImageIn) {
  return post<any>('/api/muse/image', input)
}

// —— 5.0 标题生成：服务端固定使用 doubao-seed-2-1-pro-260628
export function generateTitles(context: string) {
  return post<any>('/api/muse/title', { context })
}

// —— 4.0 成片合成：服务端下载复刻片段，ffmpeg 拼接并烧录字幕
export interface ComposeRenderIn {
  clips: { url: string; trimStart: number; trimEnd: number; duration: number; speed: number }[]
  subtitleOn: boolean
  subtitles: { start: number; end: number; text: string }[]
}
export function renderComposition(input: ComposeRenderIn) {
  return post<{ ok: boolean; video_url: string; render_id: string }>('/api/compose/render', input)
}

// —— 交付包导出：服务端打包合成 MP4、所选封面、标题元数据
export function exportDeliveryPackage(input: { video_url: string; cover_url: string; title: string }) {
  return post<{ ok: boolean; package_url: string }>('/api/export/package', input)
}

// —— 4) 文生/图生视频（seedance 2.0，模型广场统一入口 text2video/submit）
// 带 image_url（内容参考图公网 URL）即图生视频；不带即纯文生视频。
// ⚠️ 语义：这里的参考图是「内容/风格参考」，不是「锁定首帧」。seedance 的 submit
//    只暴露 image_url 一个字段，首帧 vs 内容参考的区别由 prompt 措辞承载——
//    我们在 prompt 里显式声明「以参考图为画面内容/风格基调，生成全新运镜」，
//    而非「以此图为固定开场帧」。见 refPromptForI2V()。
// 统一固定模型：seedance 2.0（模型广场模型名）。前端提交显式带上，链路可追溯。
export const SEEDANCE_2_0 = 'doubao-seedance-2-0-260128'
// seedance 2.0 提交约束（探测确认）：duration 允许范围 4~15 秒，超出会被网关直接拒绝
// （错误示例："invalid duration: 3, allowed range for Seedance 2.0: 4-15 seconds"）。
// 分镜时长本身仍按原视频时间轴自然分段（不因模型限制而改变分段逻辑），
// 仅在提交模型前夹紧到这个范围。
export const SEEDANCE_2_0_MIN_DURATION = 4
export const SEEDANCE_2_0_MAX_DURATION = 15
export function clampSeedanceDuration(sec: number): number {
  return Math.min(SEEDANCE_2_0_MAX_DURATION, Math.max(SEEDANCE_2_0_MIN_DURATION, Math.round(sec)))
}
export interface VideoSubmitIn {
  prompt: string
  model?: string
  duration?: number
  aspect_ratio?: string
  // Seedance 2.0 实测只接受 720p / 1080p / 2k；480p 会被模型广场拒绝。
  resolution?: '720p' | '1080p' | '2k'
  sound?: 'on' | 'off'               // 兼容旧模型字段
  generate_audio?: boolean            // Seedance 2.0 官方字段
  reference_images?: string[]         // Seedance 2.0 内容参考图列表
  image_url?: string                  // 兼容旧调用，服务端会归一化为 reference_images
}

// 把参考图 prompt 包一层「内容参考」语义，避免被当成锁定首帧。
export function refPromptForI2V(basePrompt: string): string {
  return `${basePrompt}\n\n（参考图仅作为画面内容与风格基调的参考，请据此生成全新的、连贯的运镜与动作，不要将参考图当作固定不动的首帧。）`
}

// 上传一张参考图，落盘拿到公网可达 URL（复用视频上传通道 /api/upload）。
// 返回的 url 可直接作为 submitVideo 的 image_url。
export async function uploadImageForI2V(
  blobUrl: string,
  opts: { onProgress?: (pct: number) => void } = {},
): Promise<{ url: string; bytes: number; name: string }> {
  const resp = await fetch(blobUrl)
  const blob = await resp.blob()
  const contentType = blob.type || 'image/png'
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', BASE + '/api/upload')
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = e => { if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      let data: any = {}
      try { data = JSON.parse(xhr.responseText) } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.url) resolve({ url: data.url, bytes: data.bytes, name: data.name })
      else reject(new Error(data?.error || `参考图上传失败 HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('参考图上传网络错误'))
    xhr.send(blob)
  })
}
export function submitVideo(input: VideoSubmitIn) {
  // 未显式指定则固定用 seedance 2.0
  return post<any>('/api/muse/video/submit', { model: SEEDANCE_2_0, ...input })
}
export function queryVideo(task_id: string) {
  return post<any>('/api/muse/video/result', { task_id })
}
// 便捷：轮询到完成
export async function generateVideoAndWait(input: VideoSubmitIn, opts: { maxMs?: number; intervalMs?: number; onTick?: (n: number, r: any) => void } = {}) {
  const { maxMs = 20 * 60 * 1000, intervalMs = 5000, onTick } = opts
  const sub = await submitVideo(input)
  const task_id = sub?.data?.task_id || sub?.task_id
  if (!task_id) throw new Error(`视频任务提交失败：${sub?.message || sub?.error || JSON.stringify(sub).slice(0, 240)}`)
  const t0 = Date.now()
  let n = 0
  let consecutiveQueryErrors = 0
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    n++
    let r: any
    try {
      r = await queryVideo(task_id)
      consecutiveQueryErrors = 0
    } catch (err) {
      // 查询网关偶发无可用实例时，任务本身仍在生成；连续容忍 12 次再失败。
      consecutiveQueryErrors++
      if (consecutiveQueryErrors >= 12) throw err
      onTick?.(n, { transient_query_error: true })
      continue
    }
    onTick?.(n, r)
    const status = r?.data?.task_status || r?.task_status
    if (status && /SUCCEED|COMPLETED|DONE/i.test(status)) return r
    if (status && /FAILED|ERROR/i.test(status)) {
      const detail = r?.data?.huoshan_error_message || r?.data?.huoshan_error_code || r?.message || JSON.stringify(r).slice(0, 300)
      throw new Error(`视频生成失败：${detail}`)
    }
  }
  throw new Error('视频生成超过 20 分钟仍未完成，请稍后重试')
}

// —— 5) 字幕擦除（AI MediaKit）
export function submitSubtitleErase(video_url: string) {
  return post<any>('/api/muse/subtitle-erase/submit', { video_url })
}
export function querySubtitleErase(task_id: string) {
  return post<any>('/api/muse/subtitle-erase/result', { task_id })
}
export async function eraseSubtitleAndWait(video_url: string, opts: { maxMs?: number; intervalMs?: number; onTick?: (n: number, r: any) => void } = {}) {
  const { maxMs = 8 * 60 * 1000, intervalMs = 4000, onTick } = opts
  const sub = await submitSubtitleErase(video_url)
  const task_id = sub?.task_id || sub?.data?.task_id
  if (!task_id) throw new Error('submit ok but no task_id: ' + JSON.stringify(sub))
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    n++
    const r = await querySubtitleErase(task_id)
    onTick?.(n, r)
    const status = r?.status || r?.data?.status
    if (status && /completed|succeed|done/i.test(status)) return r
    if (status && /failed|error/i.test(status)) throw new Error('subtitle erase failed: ' + JSON.stringify(r))
  }
  throw new Error('subtitle erase timeout')
}
