// 生产启动器：同一端口同时提供 /api/* 后端 & /* 静态托管（dist/）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Converter } from 'opencc-js'
import {
  chatCompletion,
  chatWithMedia,
  generateImage,
  submitText2Video,
  submitReference2Video,
  queryText2Video,
  submitSubtitleErase,
  querySubtitleErase,
  getMuseToken,
} from './muse.mjs'
import { BREAKDOWN_STRATEGY_SYSTEM_PROMPT_COMPACT, ANALYZE_SHOT_SYSTEM_PROMPT_COMPACT, ASR_TRANSCRIPTION_SYSTEM_PROMPT } from './skills.mjs'
import { createTask, deleteTask, getTask, listTasks, saveTaskMedia, taskMediaPath, taskMediaUrl, updateTask } from './taskStore.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const UPLOADS = path.join(DIST, 'uploads')
try { fs.mkdirSync(UPLOADS, { recursive: true }) } catch {}

// —— 加载 .env
function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return
  for (const line of fs.readFileSync(filepath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (!process.env[m[1]]) process.env[m[1]] = val
  }
}
loadEnv(path.join(ROOT, 'server', '.env'))
loadEnv(path.join(ROOT, '.env'))

const PORT = Number(process.env.PORT || 4322)
const REVERSE_MODEL = 'doubao-seed-2-1-pro-260628'
const MODELS = {
  chat: process.env.MODEL_CHAT || 'gpt-5.5',
  reverse: REVERSE_MODEL,
  image: process.env.MODEL_IMAGE || 'doubao-seedream-5.0-lite',
  video: process.env.MODEL_VIDEO || 'doubao-seedance-2-0-260128',
}

function resolveFfmpegPath() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(ROOT, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    // VideoFusion 桌面版自带静态 ffmpeg，可作为 macOS 本机免安装回退。
    '/Applications/VideoFusion-macOS.app/Contents/Resources/ffmpeg',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch {}
  }
  return 'ffmpeg'
}
const FFMPEG_BIN = resolveFfmpegPath()
const openccToSimplified = Converter({ from: 'tw', to: 'cn' })
const toSimplifiedChinese = text => openccToSimplified(String(text || ''))
  // 个别模型会直接输出异体简化字“幺”，OpenCC 不会把它视作繁体，统一规范为大陆常用字。
  .replace(/什幺/g, '什么')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

// 读取原始二进制体（用于视频上传），带大小上限（默认 200MB）
function readRawBody(req, maxBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > maxBytes) { reject(Object.assign(new Error(`上传超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`), { status: 413 })); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const EXT_BY_MIME = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv',
  // 图生视频参考图也走 /api/upload 落盘拿公网 URL，需正确落扩展名，
  // 否则会被当成 .mp4 / video/mp4，seedance 拉取参考图会失败。
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
}
const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}

// gemini（Vertex AI）内联视频体积上限。经 aimixer 线上验证 30MB 稳定可用，
// 超过则 gemini 侧会拒绝或超时。裁剪时已限制时长，通常不会触及。
const INLINE_MAX_BYTES = 40 * 1024 * 1024

// ⚠️ 视频反推的核心策略：把本机 uploads 里的视频读成 data:base64 内联给 gemini，
// 而【不是】给它一个公网 URL。原因：gemini 后端是境外 Vertex AI，它抓取远程 URL
// 需要 URL 在【境外公网可达】。本 CVM（devcloud）的公网出口对境外不可达，
// 拼任何 http://<ip>:<port>/uploads/xxx 都会报 URL_UNREACHABLE / robots error。
// 内联 base64 不需要 gemini 做任何网络抓取，直接消费数据 —— 这是 aimixer 已验证可用的路径。
// 入参可以是 uploads 文件名（如 up_xxx.mp4）或本机 uploads 的完整 URL。
function inlineLocalVideoAsDataUrl(videoRef) {
  if (!videoRef || typeof videoRef !== 'string') return null
  // 已经是 data: 前缀，直接用
  if (videoRef.startsWith('data:')) return videoRef

  let abs = null
  // 1) 优先当作视频缓存 id（trimmed_id / raw_id）——服务端 ffmpeg 裁剪后的小片段走这条
  if (/^[A-Za-z0-9_-]+$/.test(videoRef) && !videoRef.includes('.')) {
    abs = resolveVideoPath(videoRef)
  }
  // 2) 从 preview URL 里提取缓存 id
  if (!abs) {
    const pm = videoRef.match(/\/api\/video\/preview\/([A-Za-z0-9_-]+)/)
    if (pm) abs = resolveVideoPath(pm[1])
  }
  // 3) 回退：老的 uploads 目录（裸文件名或 /uploads/xxx URL）
  if (!abs) {
    let name = null
    const m = videoRef.match(/\/uploads\/([A-Za-z0-9._-]+)$/)
    if (m) name = m[1]
    else if (/^[A-Za-z0-9._-]+\.(mp4|mov|webm|avi|mkv)$/i.test(videoRef)) name = videoRef
    if (name) {
      const up = path.join(UPLOADS, name)
      if (up.startsWith(UPLOADS) && fs.existsSync(up)) abs = up
    }
  }
  if (!abs || !fs.existsSync(abs)) return null // 不是本机文件（例如真正的第三方公网 URL），交给上游按 URL 处理
  const st = fs.statSync(abs)
  if (st.size > INLINE_MAX_BYTES) {
    throw Object.assign(
      new Error(`视频 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过内联上限 ${INLINE_MAX_BYTES / 1024 / 1024}MB，请裁剪到更短片段后再反推`),
      { status: 413 },
    )
  }
  const ext = path.extname(abs).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'video/mp4'
  const buf = fs.readFileSync(abs)
  return `data:${mime};base64,${buf.toString('base64')}`
}

// 定期清理超过 6 小时的上传文件，避免磁盘堆积
function sweepUploads() {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(UPLOADS)) {
      const fp = path.join(UPLOADS, f)
      try { if (now - fs.statSync(fp).mtimeMs > 6 * 3600 * 1000) fs.unlinkSync(fp) } catch {}
    }
  } catch {}
}
setInterval(sweepUploads, 30 * 60 * 1000).unref?.()

// ============================================================================
// 视频缓存 + 服务端 ffmpeg 裁剪（照搬同机 aimixer-tool 已验证方案）
//   上传原视频 → raw_id  →  ffmpeg 真裁剪成 3~120s 小片段 → trimmed_id
//   反推时只内联那个小片段，体积压力彻底消除（大视频也能用）。
//   文件落在 dist/uploads/videos/，30 分钟未访问自动清理。
// ============================================================================
// 原视频/裁剪片段属于运行时缓存，不应写进 dist（部署目录可能是只读挂载）。
// 默认使用系统临时目录；生产环境可通过 TOUSHI_RUNTIME_DIR 指定持久可写盘。
const RUNTIME_DIR = process.env.TOUSHI_RUNTIME_DIR || path.join(os.tmpdir(), 'toushi-app-runtime')
const VIDEO_CACHE_DIR = path.join(RUNTIME_DIR, 'videos')
const LEGACY_VIDEO_CACHE_DIR = path.join(UPLOADS, 'videos')
const VIDEO_CACHE_TTL_MS = 30 * 60 * 1000            // 30 分钟
const VIDEO_MAX_RAW_BYTES = 200 * 1024 * 1024        // 原视频 200MB 上限
const VIDEO_MAX_RAW_DURATION_SEC = 180               // 原视频时长上限
const TRIM_MIN_DURATION_SEC = 3                      // 裁剪窗口最短
const TRIM_MAX_DURATION_SEC = 180                    // 裁剪窗口最长（按用户要求 3~180s）
const VIDEO_ALLOWED_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi'])
fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true })

function genVideoId() {
  return crypto.randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function pickVideoExt(filename, mime) {
  const ext = (path.extname(filename || '') || '').toLowerCase()
  if (VIDEO_ALLOWED_EXT.has(ext)) return ext
  if (typeof mime === 'string') {
    if (mime.includes('webm')) return '.webm'
    if (mime.includes('quicktime')) return '.mov'
    if (mime.includes('matroska')) return '.mkv'
  }
  return '.mp4'
}
// 找 cache 下匹配 id.* 的文件（防路径穿越：仅 base64url 字符）
function resolveVideoPath(videoId) {
  if (!videoId || typeof videoId !== 'string') return null
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(videoId)) return null
  for (const dir of [VIDEO_CACHE_DIR, LEGACY_VIDEO_CACHE_DIR]) {
    try {
      const hit = fs.readdirSync(dir).find(f => f.split('.')[0] === videoId)
      if (hit) return path.join(dir, hit)
    } catch {}
  }
  return null
}
function touchVideoFile(p) { try { const now = new Date(); fs.utimesSync(p, now, now) } catch {} }
function cleanupExpiredVideos() {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(VIDEO_CACHE_DIR)) {
      const p = path.join(VIDEO_CACHE_DIR, f)
      try { if (now - fs.statSync(p).mtimeMs > VIDEO_CACHE_TTL_MS) fs.unlinkSync(p) } catch {}
    }
  } catch {}
}
cleanupExpiredVideos()
setInterval(cleanupExpiredVideos, 5 * 60 * 1000).unref?.()

function runChild(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000) })
    child.on('error', e => reject(new Error(`${label} 启动失败：${e.message}`)))
    child.on('close', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${label} 退出码 ${code ?? 'null'}${signal ? ` (${signal})` : ''}：${stderr.slice(-900)}`)))
  })
}

async function transcribeVideoWithWhisper(videoPath) {
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('ASR 源视频不存在')
  const asrDir = fs.mkdtempSync(path.join(RUNTIME_DIR, 'asr-'))
  const wavPath = path.join(asrDir, 'audio.wav')
  const outputBase = path.join(asrDir, 'transcript')
  const modelPath = process.env.WHISPER_MODEL_PATH || '/opt/toushi-asr/ggml-large-v3-turbo-q5_0.bin'
  try {
    await runChild(FFMPEG_BIN, ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath], 'ASR 音轨提取')
    if (!fs.existsSync(modelPath)) throw new Error(`Whisper 模型不存在：${modelPath}`)
    const cliPath = String(process.env.WHISPER_CLI_PATH || '').trim()
    if (cliPath && fs.existsSync(cliPath)) {
      await runChild(cliPath, ['-m', modelPath, '-f', wavPath, '-l', 'zh', '-oj', '-of', outputBase, '-t', '8'], 'Whisper ASR')
    } else {
      const docker = process.env.DOCKER_PATH || 'docker'
      const image = process.env.WHISPER_DOCKER_IMAGE || 'ghcr.io/ggml-org/whisper.cpp:main'
      const modelDir = path.dirname(modelPath)
      const modelName = path.basename(modelPath)
      const command = `/app/build/bin/whisper-cli -m /models/${modelName} -f /work/audio.wav -l zh -oj -of /work/transcript -t 8`
      await runChild(docker, ['run', '--rm', '-v', `${asrDir}:/work`, '-v', `${modelDir}:/models:ro`, image, command], 'Whisper ASR')
    }
    const parsed = JSON.parse(fs.readFileSync(`${outputBase}.json`, 'utf8'))
    const rows = Array.isArray(parsed?.transcription) ? parsed.transcription : []
    return rows.map(row => ({
      start: Math.max(0, Number(row?.offsets?.from) / 1000 || 0),
      end: Math.max(0, Number(row?.offsets?.to) / 1000 || 0),
      text: toSimplifiedChinese(String(row?.text || '').trim()),
    })).filter(row => row.text && row.end > row.start)
  } finally {
    try { fs.rmSync(asrDir, { recursive: true, force: true }) } catch {}
  }
}

// —— ffmpeg 重编码裁剪（x264+aac，veryfast），输出 mp4 兼容 gemini 视频理解
// 时长上限放宽到 180s 后，长片段用 CRF 可能超过内联上限。改为按时长自适应：
//   · ≤60s：CRF 23 原分辨率（画质优先，体积一定不超）
//   · >60s：限长边 720 + 视频码率上限，使 180s 片段稳定落在内联上限内
//     目标：给定 INLINE_MAX_BYTES（40MB），扣掉音频与封装余量后按时长反推视频码率上限。
function ffmpegTrim(srcPath, destPath, start, duration) {
  return new Promise((resolve, reject) => {
    let vArgs
    if (duration <= 60) {
      vArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
    } else {
      // 预算：内联上限 40MB，留 12% 封装/音频冗余 → 视频可用 ~35.2MB
      // 视频码率(kbps) = 可用bit / 时长 / 1000；再夹在 [600, 3500] kbps
      const budgetBits = INLINE_MAX_BYTES * 8 * 0.88
      let vkbps = Math.floor(budgetBits / duration / 1000)
      vkbps = Math.max(600, Math.min(3500, vkbps))
      vArgs = [
        '-vf', "scale='min(720,iw)':'-2'",
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${vkbps}k`, '-maxrate', `${Math.round(vkbps * 1.3)}k`, '-bufsize', `${vkbps * 2}k`,
      ]
    }
    const args = [
      '-y', '-ss', String(start.toFixed(3)), '-i', srcPath, '-t', String(duration.toFixed(3)),
      ...vArgs,
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', destPath,
    ]
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000) })
    child.on('error', e => reject(new Error(`ffmpeg 启动失败：${e.message}（请确认服务器已安装 ffmpeg）`)))
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-400)}`)))
  })
}

// —— 读裁剪后的小片段转 data:base64 内联（供 gemini 反推；不给公网 URL）
function inlineTrimmedVideo(trimmedId) {
  const fp = resolveVideoPath(trimmedId)
  if (!fp) throw Object.assign(new Error('裁剪片段已过期或不存在，请重新上传并裁剪'), { status: 404 })
  touchVideoFile(fp)
  const st = fs.statSync(fp)
  if (st.size > INLINE_MAX_BYTES) {
    throw Object.assign(new Error(`裁剪片段 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过内联上限 ${INLINE_MAX_BYTES / 1024 / 1024}MB，请裁剪到更短片段`), { status: 413 })
  }
  const ext = path.extname(fp).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'video/mp4'
  return `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`
}

// —— 统一承载优先级（reverse-video / breakdown-strategy / analyze-shot 三个多模态接口共用）：
//   1) trimmed_id —— 服务端 ffmpeg 裁剪出的小片段，体积最小、最稳，优先内联
//   2) name       —— 老 uploads 整段（兜底，可能较大），读盘转 base64 内联
//   3) video_url  —— 第三方公网 URL，返回 null 交上游按 URL 原样抓取
function resolveInlineMedia({ trimmed_id, name, video_url }) {
  if (trimmed_id) return inlineTrimmedVideo(String(trimmed_id))
  const ref = name || video_url
  if (!ref) return null
  return inlineLocalVideoAsDataUrl(ref)
}

function inlineTaskReferenceImage(ref) {
  if (String(ref || '').startsWith('data:image/')) return String(ref)
  let pathname = ''
  try { pathname = new URL(String(ref), 'http://local').pathname } catch {}
  const match = pathname.match(/^\/api\/task-media\/([A-Za-z0-9_-]{8,80})\/(.+)$/)
  if (!match) return String(ref || '')
  const file = taskMediaPath(match[1], decodeURIComponent(match[2]))
  if (!file) throw Object.assign(new Error('参考图文件不存在，请重新上传'), { status: 404 })
  const stat = fs.statSync(file)
  if (stat.size > 10 * 1024 * 1024) throw Object.assign(new Error('单张参考图不能超过 10MB'), { status: 413 })
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

// 视频反推、整片策略分析、单镜分析均固定使用同一个豆包模型，不允许模型降级。
// 这样每份分析结果都可追溯到 doubao-seed-2-1-pro-260628；上游若拒绝视频承载格式，
// 直接返回上游错误，绝不悄悄切换 Gemini 把失败伪装成成功。
function assertReverseModel(model) {
  if (model && model !== REVERSE_MODEL) {
    throw Object.assign(new Error(`视频反推模型已锁定为 ${REVERSE_MODEL}，不允许覆盖为 ${model}`), { status: 400 })
  }
}
async function runReverseMedia(route, opts) {
  console.log(`[reverse] start route=${route} model=${REVERSE_MODEL} media=${String(opts.video_url || '').startsWith('data:') ? 'data-video' : 'remote-url'}`)
  const startedAt = Date.now()
  try {
    const data = await chatWithMedia({ ...opts, model: REVERSE_MODEL })
    console.log(`[reverse] ok route=${route} model=${REVERSE_MODEL} elapsed_ms=${Date.now() - startedAt}`)
    return data
  } catch (err) {
    console.error(`[reverse] fail route=${route} model=${REVERSE_MODEL} status=${err?.status || 500} elapsed_ms=${Date.now() - startedAt}`)
    throw err
  }
}

function parseModelJson(raw) {
  const source = String(raw || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(source) } catch {}
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue }
    if (ch === '"') { quoted = true; continue }
    if (ch === '{') depth++
    if (ch === '}' && --depth === 0) { try { return JSON.parse(source.slice(start, i + 1)) } catch { return null } }
  }
  return null
}
function strategySeconds(value) {
  const parts = String(value || '').split(':').map(Number)
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1]
  return Number(value) || 0
}
function normalizeStrategyJson(raw) {
  const parsed = parseModelJson(raw)
  const source = parsed?.segments ? parsed : parsed?.strategy_skill || parsed?.data || parsed
  if (!source || !Array.isArray(source.segments) || !source.segments.length) return null
  const roles = new Set(['hook', 'point', 'demo', 'transition', 'proof', 'cta'])
  const segments = source.segments.map((seg, i) => {
    const start = String(seg.start ?? '00:00')
    const end = String(seg.end ?? start)
    const inferred = Math.max(0.1, strategySeconds(end) - strategySeconds(start))
    const duration = Number.isFinite(Number(seg.duration)) && Number(seg.duration) > 0 ? Number(seg.duration) : inferred
    return {
      index: i + 1, start, end, duration: +duration.toFixed(2),
      role: roles.has(seg.role) ? seg.role : 'point',
      visual: String(seg.visual || ''), action: String(seg.action || ''), camera: String(seg.camera || ''),
      on_screen_text: Array.isArray(seg.on_screen_text) ? seg.on_screen_text.map(String) : [],
      source_audio: String(seg.source_audio || ''),
      // 默认口播严格使用 ASR 原文，禁止模型的润色稿覆盖原片口播。
      asr_text: String(seg.asr_text || ''),
      voiceover_script: String(seg.asr_text || ''),
      role_note: String(seg.role_note || ''), merge_reason: String(seg.merge_reason || ''),
    }
  })
  const hooks = source.strategy?.attention_hooks || {}
  return {
    meta: { title: String(source.meta?.title || '视频拆镜策略'), total_duration_s: Number(source.meta?.total_duration_s) || strategySeconds(segments.at(-1)?.end), aspect: String(source.meta?.aspect || '9:16'), routine: String(source.meta?.routine || ''), segment_count: segments.length, disclaimer: String(source.meta?.disclaimer || '') },
    strategy: { core_selling_point: String(source.strategy?.core_selling_point || ''), expression_style: String(source.strategy?.expression_style || ''), shot_logic: String(source.strategy?.shot_logic || ''), narrative_structure: String(source.strategy?.narrative_structure || ''), attention_hooks: { pre_roll: String(hooks.pre_roll || ''), mid_roll: String(hooks.mid_roll || ''), end_roll: String(hooks.end_roll || '') } },
    segments,
    remake: { anchors: Array.isArray(source.remake?.anchors) ? source.remake.anchors.map(String) : [], variables: Array.isArray(source.remake?.variables) ? source.remake.variables.map(String) : [], production_tips: Array.isArray(source.remake?.production_tips) ? source.remake.production_tips.map(String) : [], cautions: Array.isArray(source.remake?.cautions) ? source.remake.cautions.map(String) : [] },
  }
}
function setResponseContent(data, content) {
  if (data?.choices?.[0]?.message) data.choices[0].message.content = content
  else if (data?.data?.choices?.[0]?.message) data.data.choices[0].message.content = content
  return data
}

function normalizeAsrJson(raw) {
  const parsed = parseModelJson(raw)
  const rows = Array.isArray(parsed?.segments) ? parsed.segments : []
  return rows.map(row => ({
    start: Math.max(0, Number(row?.start) || 0),
    end: Math.max(0, Number(row?.end) || 0),
    text: toSimplifiedChinese(String(row?.text || '').trim()),
  })).filter(row => row.text && row.end > row.start)
}

async function correctAsrWithVisual(mediaUrl, transcript) {
  if (!mediaUrl || !transcript.length) return transcript
  const timedText = transcript.map(row => `[${row.start.toFixed(2)}-${row.end.toFixed(2)}] ${row.text}`).join('\n').slice(0, 14000)
  const result = await runReverseMedia('asr-visual-correction', {
    video_url: mediaUrl,
    system: `你是中文视频逐字稿校对员。输入包含一份带时间戳的音频 ASR 草稿和原视频。请同时观看画面（尤其是字幕、商品文字、人物动作）并听音频，只修正同音字、漏字、错字和繁简体，不得概括、润色、扩写或把画面中未说出的文字加入稿件。保留原时间范围。统一输出简体中文。只输出 JSON：{"segments":[{"start":0.0,"end":1.2,"text":"逐字原话"}]}`,
    prompt: `请结合原视频画面与音频校正以下 ASR 草稿：\n${timedText}`,
    temperature: 0,
    max_tokens: 5200,
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
  })
  const raw = result?.choices?.[0]?.message?.content ?? result?.data?.choices?.[0]?.message?.content ?? ''
  const corrected = normalizeAsrJson(raw)
  if (!corrected.length) return transcript
  console.log(`[asr] visual correction ok raw=${transcript.length} corrected=${corrected.length}`)
  return corrected
}

function removeAdjacentVoiceoverDuplicates(segments) {
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
    result[i].asr_text = cleaned
    result[i].voiceover_script = cleaned
  }
  return result
}

function applyAsrToStrategy(strategy, transcript) {
  if (!transcript.length) return strategy
  const assigned = strategy.segments.map((seg, segIndex) => {
      const start = strategySeconds(seg.start)
      const end = strategySeconds(seg.end)
      const text = transcript
        // ASR 时间片可能跨越镜头切点。按时间片中心点唯一归属，禁止同一句同时进入前后两段。
        .filter(row => {
          const midpoint = (row.start + row.end) / 2
          return midpoint >= start && (midpoint < end || (segIndex === strategy.segments.length - 1 && midpoint <= end))
        })
        .map(row => String(row.text || '').trim().replace(/[，。！？；：,.!?]+$/g, ''))
        .filter(Boolean)
        .join('，')
        .replace(/，{2,}/g, '，')
        .replace(/，$/g, '')
        .trim()
      const punctuated = text && !/[。！？!?]$/.test(text) ? `${text}。` : text
      const exact = punctuated || String(seg.asr_text || '').trim()
      return { ...seg, asr_text: exact, voiceover_script: exact }
    })
  return { ...strategy, segments: removeAdjacentVoiceoverDuplicates(assigned) }
}

// —— POST /api/video/upload  (raw body，header X-Filename / Content-Type) → raw_id
async function handleVideoUpload(req, res) {
  const filename = decodeURIComponent(String(req.headers['x-filename'] || 'video'))
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
  const id = genVideoId()
  const ext = pickVideoExt(filename, mime)
  const dest = path.join(VIDEO_CACHE_DIR, `${id}${ext}`)
  return new Promise(resolve => {
    const ws = fs.createWriteStream(dest)
    let total = 0, aborted = false
    const fail = (status, msg) => {
      if (aborted) return; aborted = true
      try { req.unpipe(ws) } catch {}; try { ws.destroy() } catch {}; try { fs.unlinkSync(dest) } catch {}
      json(res, status, { ok: false, error: msg }); resolve()
    }
    req.on('data', c => { total += c.length; if (total > VIDEO_MAX_RAW_BYTES) fail(413, `视频体积超过 ${(VIDEO_MAX_RAW_BYTES / 1024 / 1024).toFixed(0)}MB 上限`) })
    req.on('error', e => fail(400, `请求异常：${e?.message || e}`))
    req.on('aborted', () => fail(400, '客户端中断了上传'))
    ws.on('error', e => fail(500, `写入失败：${e?.message || e}`))
    ws.on('finish', () => {
      if (aborted) return
      if (total === 0) { try { fs.unlinkSync(dest) } catch {}; json(res, 400, { ok: false, error: '空请求体，请重新上传' }); return resolve() }
      console.log(`[video-upload] ok id=${id} size=${total} mime=${mime}`)
      json(res, 200, { ok: true, raw_id: id, size: total, mime, ext, ttl_seconds: VIDEO_CACHE_TTL_MS / 1000 })
      resolve()
    })
    req.pipe(ws)
  })
}

// —— POST /api/video/import-url  body:{url} → 后端代下载 → raw_id（与本地上传同一后续流程）
async function handleVideoImportUrl(req, res, body) {
  const u = String(body?.url || '').trim()
  if (!/^https?:\/\//i.test(u)) return json(res, 400, { ok: false, error: '请提供 http(s):// 开头的视频地址' })
  let resp
  try { resp = await fetch(u, { redirect: 'follow' }) }
  catch (e) { return json(res, 502, { ok: false, error: `下载失败：${e?.message || e}` }) }
  if (!resp.ok) return json(res, 502, { ok: false, error: `远端返回 HTTP ${resp.status}` })
  const mime = (resp.headers.get('content-type') || 'video/mp4').split(';')[0].trim()
  const len = Number(resp.headers.get('content-length') || 0)
  if (len && len > VIDEO_MAX_RAW_BYTES) return json(res, 413, { ok: false, error: `视频体积超过 ${(VIDEO_MAX_RAW_BYTES / 1024 / 1024).toFixed(0)}MB 上限` })
  const id = genVideoId()
  const ext = pickVideoExt(u.split('?')[0], mime)
  const dest = path.join(VIDEO_CACHE_DIR, `${id}${ext}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > VIDEO_MAX_RAW_BYTES) return json(res, 413, { ok: false, error: `视频体积超过上限` })
  if (!buf.length) return json(res, 400, { ok: false, error: '远端视频为空' })
  fs.writeFileSync(dest, buf)
  console.log(`[video-import-url] ok id=${id} size=${buf.length} from=${u.slice(0, 80)}`)
  return json(res, 200, { ok: true, raw_id: id, size: buf.length, mime, ext, ttl_seconds: VIDEO_CACHE_TTL_MS / 1000 })
}

// —— POST /api/video/trim  body:{raw_id,start,end} → ffmpeg 裁剪 → trimmed_id
async function handleVideoTrim(req, res, body) {
  const rawId = String(body?.raw_id || '').trim()
  const start = Number(body?.start), end = Number(body?.end)
  if (!rawId) return json(res, 400, { ok: false, error: 'raw_id 不能为空' })
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return json(res, 400, { ok: false, error: '裁剪区间不合法' })
  const dur = end - start
  if (dur < TRIM_MIN_DURATION_SEC - 0.01 || dur > TRIM_MAX_DURATION_SEC + 0.01) {
    return json(res, 400, { ok: false, error: `裁剪时长应在 ${TRIM_MIN_DURATION_SEC}~${TRIM_MAX_DURATION_SEC} 秒之间` })
  }
  const srcPath = resolveVideoPath(rawId)
  if (!srcPath) return json(res, 404, { ok: false, error: '原视频已过期或不存在，请重新上传' })
  touchVideoFile(srcPath)
  const trimmedId = genVideoId()
  const destPath = path.join(VIDEO_CACHE_DIR, `${trimmedId}.mp4`)
  await ffmpegTrim(srcPath, destPath, start, dur)
  let st
  try { st = fs.statSync(destPath) } catch { return json(res, 500, { ok: false, error: 'ffmpeg 未生成输出文件' }) }
  if (st.size === 0) { try { fs.unlinkSync(destPath) } catch {}; return json(res, 500, { ok: false, error: 'ffmpeg 输出为空，请换一个视频' }) }
  console.log(`[video-trim] ok raw=${rawId} → trimmed=${trimmedId} ${start.toFixed(2)}s dur=${dur.toFixed(2)}s size=${st.size}B`)
  return json(res, 200, { ok: true, trimmed_id: trimmedId, size: st.size, duration: dur, ttl_seconds: VIDEO_CACHE_TTL_MS / 1000 })
}

// —— POST /api/video/split-segments  body:{source_id, segments:[{start,end}]} → 批量 ffmpeg 裁剪 → 每段一个 shot_trimmed_id
// source_id 可以是 raw_id 或 trimmed_id（都在同一个 VIDEO_CACHE_DIR，resolveVideoPath 通用）。
// segments 的 start/end 是【相对 source_id 这条视频自己的秒数】——前端传参前已经把「拆镜拉片专家」
// 输出的 mm:ss 转成相对裁剪片段的秒数，这里不做任何时间基准转换，只管按秒裁。
async function handleVideoSplitSegments(req, res, body) {
  const sourceId = String(body?.source_id || '').trim()
  const segments = Array.isArray(body?.segments) ? body.segments : []
  if (!sourceId) return json(res, 400, { ok: false, error: 'source_id 不能为空' })
  if (!segments.length) return json(res, 400, { ok: false, error: 'segments 不能为空' })
  const srcPath = resolveVideoPath(sourceId)
  if (!srcPath) return json(res, 404, { ok: false, error: '源视频已过期或不存在，请重新上传/裁剪' })
  touchVideoFile(srcPath)

  const results = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const start = Number(seg?.start), end = Number(seg?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      results.push({ index: i, ok: false, error: '区间不合法' })
      continue
    }
    const dur = end - start
    const shotId = genVideoId()
    const destPath = path.join(VIDEO_CACHE_DIR, `${shotId}.mp4`)
    try {
      await ffmpegTrim(srcPath, destPath, start, dur)
      const st = fs.statSync(destPath)
      if (st.size === 0) throw new Error('ffmpeg 输出为空')
      results.push({ index: i, ok: true, shot_trimmed_id: shotId, size: st.size, duration: dur })
    } catch (e) {
      try { fs.unlinkSync(destPath) } catch {}
      results.push({ index: i, ok: false, error: String(e?.message || e).slice(0, 200) })
    }
  }
  const okCount = results.filter(r => r.ok).length
  console.log(`[video-split-segments] source=${sourceId} ${okCount}/${segments.length} ok`)
  return json(res, 200, { ok: true, results, ttl_seconds: VIDEO_CACHE_TTL_MS / 1000 })
}

// —— GET /api/video/preview/:id  流式播放（支持 Range 206）
function handleVideoPreview(req, res) {
  const id = (req.url || '').split('?')[0].replace(/^\/api\/video\/preview\//, '').trim()
  const fp = resolveVideoPath(id)
  if (!fp) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('视频已过期或不存在') }
  touchVideoFile(fp)
  const size = fs.statSync(fp).size
  const ext = path.extname(fp).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'video/mp4'
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    if (m) {
      const s = Number(m[1]), e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (s < size && e >= s) {
        res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Content-Type': mime })
        return fs.createReadStream(fp, { start: s, end: e }).pipe(res)
      }
    }
  }
  res.writeHead(200, { 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' })
  fs.createReadStream(fp).pipe(res)
}

// —— 成片合成：下载复刻片段，按时间轴裁剪/变速，ffmpeg 拼接并将字幕烧录进 MP4。
const RENDER_DIR = path.join(UPLOADS, 'renders')
try { fs.mkdirSync(RENDER_DIR, { recursive: true }) } catch {}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 6000) stderr = stderr.slice(-6000) })
    child.on('error', e => reject(new Error(`ffmpeg 启动失败：${e.message}`)))
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg 合成失败（${code}）：${stderr.slice(-600)}`)))
  })
}
function toSrtTime(sec) {
  const ms = Math.max(0, Math.round(Number(sec || 0) * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms % 3600000 / 60000)
  const s = Math.floor(ms % 60000 / 1000)
  const mm = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mm).padStart(3, '0')}`
}
function absoluteMediaUrl(req, value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `http://${host}${raw.startsWith('/') ? '' : '/'}${raw}`
}
async function downloadMedia(url, dest) {
  const resp = await fetch(url, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`下载媒体失败：HTTP ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!buf.length) throw new Error('下载媒体为空')
  if (buf.length > 300 * 1024 * 1024) throw new Error('媒体超过 300MB 合成上限')
  fs.writeFileSync(dest, buf)
}
async function handleComposeRender(req, res, body) {
  const clips = Array.isArray(body?.clips) ? body.clips.filter(c => c?.url) : []
  const subtitles = body?.subtitleOn && Array.isArray(body?.subtitles) ? body.subtitles.filter(s => s?.text && Number(s.end) > Number(s.start)) : []
  if (!clips.length) return json(res, 400, { error: '至少需要一个可合成的视频片段' })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'toushi-compose-'))
  const renderId = genVideoId()
  const output = path.join(RENDER_DIR, `${renderId}.mp4`)
  try {
    const normalized = []
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      const source = path.join(work, `source-${i}.mp4`)
      await downloadMedia(absoluteMediaUrl(req, c.url), source)
      const start = Math.max(0, Number(c.trimStart) || 0)
      const duration = Math.max(0.2, Number(c.trimEnd) - start || Number(c.duration) || 1)
      const speed = Math.min(2, Math.max(0.5, Number(c.speed) || 1))
      const prepared = path.join(work, `clip-${i}.mp4`)
      // 保留每个复刻片段原生音轨；速度调整时至少保证视频时长正确，音频可由后续音轨覆盖。
      await runFfmpeg(['-y', '-ss', String(start), '-i', source, '-t', String(duration), '-filter:v', `setpts=PTS/${speed}`, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-movflags', '+faststart', prepared])
      normalized.push(prepared)
    }
    const concatList = path.join(work, 'concat.txt')
    fs.writeFileSync(concatList, normalized.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    const merged = path.join(work, 'merged.mp4')
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', '-movflags', '+faststart', merged])
    if (subtitles.length) {
      const srt = path.join(work, 'subtitles.srt')
      fs.writeFileSync(srt, subtitles.map((s, i) => `${i + 1}\n${toSrtTime(s.start)} --> ${toSrtTime(s.end)}\n${String(s.text).replace(/\r?\n/g, ' ')}\n`).join('\n'), 'utf8')
      await runFfmpeg(['-y', '-i', merged, '-vf', `subtitles=${srt}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', '-movflags', '+faststart', output])
    } else {
      fs.copyFileSync(merged, output)
    }
    console.log(`[compose] ok render=${renderId} clips=${clips.length} subtitles=${subtitles.length}`)
    return json(res, 200, { ok: true, video_url: `/uploads/renders/${renderId}.mp4`, render_id: renderId })
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
  }
}

function runZip(dest, files) {
  return new Promise((resolve, reject) => {
    const child = spawn('zip', ['-j', dest, ...files], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', e => reject(new Error(`zip 启动失败：${e.message}`)))
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`zip 打包失败（${code}）：${stderr.slice(-300)}`)))
  })
}
async function handleExportPackage(req, res, body) {
  const videoUrl = String(body?.video_url || '').trim()
  const coverUrl = String(body?.cover_url || '').trim()
  const title = String(body?.title || '').trim()
  if (!videoUrl || !coverUrl || !title) return json(res, 400, { error: '请先选择成片、封面和标题后再导出' })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'toushi-export-'))
  const packageId = genVideoId()
  const zipPath = path.join(RENDER_DIR, `${packageId}.zip`)
  try {
    const video = path.join(work, 'final-video.mp4')
    const cover = path.join(work, 'cover.jpg')
    const manifest = path.join(work, 'delivery.json')
    await downloadMedia(absoluteMediaUrl(req, videoUrl), video)
    await downloadMedia(absoluteMediaUrl(req, coverUrl), cover)
    fs.writeFileSync(manifest, JSON.stringify({ title, video: 'final-video.mp4', cover: 'cover.jpg', exported_at: new Date().toISOString() }, null, 2))
    await runZip(zipPath, [video, cover, manifest])
    console.log(`[export] ok package=${packageId}`)
    return json(res, 200, { ok: true, package_url: `/uploads/renders/${packageId}.zip` })
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
  }
}

function publicBase(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${host}`
}
function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME[ext] || MIME_BY_EXT[ext] || 'application/octet-stream'
  const size = fs.statSync(filePath).size
  const range = req.headers.range
  const match = range && /bytes=(\d+)-(\d*)/.exec(range)
  if (match) {
    const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (Number.isFinite(start) && start < size && end >= start) {
      res.writeHead(206, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      return fs.createReadStream(filePath, { start, end }).pipe(res)
    }
  }
  res.writeHead(200, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': size })
  fs.createReadStream(filePath).pipe(res)
}
async function handleTaskReferenceUpload(req, res, taskId) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) return json(res, 400, { error: '仅支持 PNG、JPG、WebP 或 GIF 商品参考图' })
  if (!getTask(taskId)) return json(res, 404, { error: '任务不存在' })
  const buf = await readRawBody(req, 20 * 1024 * 1024)
  if (!buf.length) return json(res, 400, { error: '参考图为空' })
  const filename = decodeURIComponent(String(req.headers['x-filename'] || `product${EXT_BY_MIME[contentType] || '.png'}`))
  const saved = saveTaskMedia(taskId, filename, buf)
  const relativeUrl = taskMediaUrl(taskId, saved.file)
  return json(res, 200, { ok: true, id: saved.file, name: saved.name, bytes: saved.bytes, url: relativeUrl, public_url: `${publicBase(req)}${relativeUrl}` })
}
async function handleTaskArchive(req, res, taskId, body) {
  if (!getTask(taskId)) return json(res, 404, { error: '任务不存在' })
  const source = String(body?.url || '').trim()
  if (!source) return json(res, 400, { error: 'url required' })
  const work = path.join(os.tmpdir(), `toushi-archive-${genVideoId()}`)
  try {
    await downloadMedia(absoluteMediaUrl(req, source), work)
    const name = String(body?.name || path.basename(new URL(absoluteMediaUrl(req, source)).pathname) || 'asset.mp4')
    const saved = saveTaskMedia(taskId, name, fs.readFileSync(work))
    const relativeUrl = taskMediaUrl(taskId, saved.file)
    return json(res, 200, { ok: true, id: saved.file, name: saved.name, bytes: saved.bytes, url: relativeUrl, public_url: `${publicBase(req)}${relativeUrl}` })
  } finally { try { fs.unlinkSync(work) } catch {} }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  let rel = decodeURIComponent(url.pathname)
  // ⚠️ Vertex AI（gemini 后端）抓取远程视频前，会先请求 /robots.txt。
  // 若这里走 SPA fallback 返回 index.html（HTML），Vertex 解析失败 → 判定"禁止爬取"
  // → 报 UNREACHABLE_ROBOTS_ERROR / 400 Cannot fetch content。
  // 所以必须显式返回一个"允许全部爬取"的纯文本 robots.txt。
  if (rel === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('User-agent: *\nAllow: /\n')
  }
  if (rel === '/' || rel === '') rel = '/index.html'
  const abs = path.join(DIST, rel)
  if (!abs.startsWith(DIST)) return json(res, 400, { error: 'bad path' })
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback：任何未命中的路由都返回 index.html
      const fallback = path.join(DIST, 'index.html')
      fs.readFile(fallback, (e2, data) => {
        if (e2) return json(res, 404, { error: 'not found' })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(data)
      })
      return
    }
    const ext = path.extname(abs).toLowerCase()
    const ctype = MIME[ext] || 'application/octet-stream'
    // Range 支持：Vertex AI / 视频客户端抓取大视频时常用分段请求（Range: bytes=...）。
    // 不支持 206 分段可能导致远端抓取失败或超时。这里对所有静态文件通用地实现 Range。
    const range = req.headers['range']
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        const total = st.size
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : total - 1
        if (isNaN(start) || start < 0) start = 0
        if (isNaN(end) || end >= total) end = total - 1
        if (start > end) { start = 0; end = total - 1 }
        res.writeHead(206, {
          'Content-Type': ctype,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        })
        return fs.createReadStream(abs, { start, end }).pipe(res)
      }
    }
    res.writeHead(200, { 'Content-Type': ctype, 'Accept-Ranges': 'bytes', 'Content-Length': st.size })
    fs.createReadStream(abs).pipe(res)
  })
}

async function api(req, res, p) {
  if (req.method === 'OPTIONS') return json(res, 204, {})

  // —— 视频缓存 + 服务端 ffmpeg 裁剪（照搬 aimixer）：这些需在读 JSON body 前分流
  if (p === '/api/video/upload' && req.method === 'POST') return handleVideoUpload(req, res)
  if (p.startsWith('/api/video/preview/') && req.method === 'GET') return handleVideoPreview(req, res)
  const taskMedia = /^\/api\/task-media\/([A-Za-z0-9_-]{8,80})\/([^/]+)$/.exec(p)
  if (taskMedia && req.method === 'GET') {
    const file = taskMediaPath(taskMedia[1], decodeURIComponent(taskMedia[2]))
    if (!file) return json(res, 404, { error: '任务媒体不存在' })
    return serveFile(req, res, file)
  }
  const refUpload = /^\/api\/tasks\/([A-Za-z0-9_-]{8,80})\/reference-upload$/.exec(p)
  if (refUpload && req.method === 'POST') return handleTaskReferenceUpload(req, res, refUpload[1])
  if (p === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: listTasks() })
  const taskGet = /^\/api\/tasks\/([A-Za-z0-9_-]{8,80})$/.exec(p)
  if (taskGet && req.method === 'GET') {
    const task = getTask(taskGet[1])
    return task ? json(res, 200, task) : json(res, 404, { error: '任务不存在' })
  }

  if (p === '/api/health') {
    return json(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      models: MODELS,
      reverseMediaTransport: 'openai-video_url-data-video',
      muse: {
        client: process.env.MUSE_CLIENT ? `${process.env.MUSE_CLIENT.slice(0, 4)}***` : '(未配置)',
        secret: process.env.MUSE_CLIENT_SECRET ? '已配置' : '(未配置)',
        llmBase: process.env.MUSE_LLM_BASE || 'http://30.48.128.77:8080',
      },
    })
  }
  if (p === '/api/muse/ping') {
    try { getMuseToken(); return json(res, 200, { ok: true, configured: true }) }
    catch (e) { return json(res, 500, { ok: false, error: e.message }) }
  }
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method || '')) return json(res, 405, { error: 'method not allowed' })

  // —— 上传本地视频，落盘后返回公网 URL（供 gemini 反推直接拉取，绕开 base64 体积限制）
  if (p === '/api/upload') {
    try {
      const buf = await readRawBody(req)
      if (!buf.length) return json(res, 400, { error: 'empty body' })
      const ct = (req.headers['content-type'] || '').split(';')[0].trim()
      const ext = EXT_BY_MIME[ct] || '.mp4'
      const name = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext}`
      fs.writeFileSync(path.join(UPLOADS, name), buf)
      // ⚠️ 关键：gemini 后端（Vertex AI）在【公网】拉取视频 URL。
      // 若用 req.headers.host，用户从内网域名（*.devcloud.woa.com）访问时，
      // 拼出的就是内网 URL，Google 侧公网拉不到 → 400 "Cannot fetch content from URL"。
      // 所以优先用显式配置的 PUBLIC_BASE_URL（公网 IP:端口，如 http://21.214.35.208:8080），
      // 只有它缺失时才回退到请求 Host。
      const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
      let publicUrl
      if (base) {
        publicUrl = `${base}/uploads/${name}`
      } else {
        const host = req.headers['x-forwarded-host'] || req.headers.host
        const proto = req.headers['x-forwarded-proto'] || 'http'
        publicUrl = `${proto}://${host}/uploads/${name}`
      }
      return json(res, 200, { ok: true, url: publicUrl, name, bytes: buf.length })
    } catch (e) {
      return json(res, e.status || 500, { error: e.message })
    }
  }

  let body = {}
  try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid json body' }) }

  try {
    if (p === '/api/tasks' && req.method === 'POST') {
      const task = createTask({ name: body?.name, snapshot: body?.snapshot })
      return json(res, 201, task)
    }
    const taskMutation = /^\/api\/tasks\/([A-Za-z0-9_-]{8,80})$/.exec(p)
    if (taskMutation && req.method === 'PATCH') {
      const task = updateTask(taskMutation[1], { name: body?.name, snapshot: body?.snapshot })
      return task ? json(res, 200, task) : json(res, 404, { error: '任务不存在' })
    }
    if (taskMutation && req.method === 'DELETE') {
      return deleteTask(taskMutation[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: '任务不存在' })
    }
    const archive = /^\/api\/tasks\/([A-Za-z0-9_-]{8,80})\/archive$/.exec(p)
    if (archive && req.method === 'POST') return handleTaskArchive(req, res, archive[1], body)

    // —— 视频服务端裁剪（照搬 aimixer）：需要 JSON body
    if (p === '/api/video/trim') return handleVideoTrim(req, res, body)
    if (p === '/api/video/import-url') return handleVideoImportUrl(req, res, body)
    if (p === '/api/video/split-segments') return handleVideoSplitSegments(req, res, body)
    if (p === '/api/compose/render') return handleComposeRender(req, res, body)
    if (p === '/api/export/package') return handleExportPackage(req, res, body)

    if (p === '/api/muse/reverse-video') {
      const { trimmed_id, video_url, name, prompt, model } = body
      assertReverseModel(model)
      // 承载优先级：trimmed_id → 本机 name → 第三方 video_url。视频统一通过 MUSE
      // OpenAI 兼容 messages[].content[].video_url 承载，模型固定为豆包 2.1 Pro。
      const inlined = resolveInlineMedia({ trimmed_id, name, video_url })
      const data = await runReverseMedia('reverse-video', {
        video_url: inlined || video_url,
        prompt: prompt || '请对这段广告视频做拉片分析，输出：整体内容、组织逻辑、每一段的场景/人物/动作/运镜/文案（0.5秒粒度）、以及可复用的高光片段。用中文JSON输出。',
        temperature: 0.4,
        thinking: { type: 'disabled' },
      })
      return json(res, 200, data)
    }
    // —— 拆镜拉片专家：参考视频 → 策略skill（严格JSON：segments 拆镜时间轴 + strategy 成片策略）
    // system prompt 见 skills.mjs（改编自 715-成片skill平台/拆镜拉片专家/SKILL.md）
    if (p === '/api/muse/breakdown-strategy') {
      const { trimmed_id, video_url, name, model } = body
      assertReverseModel(model)
      const inlined = resolveInlineMedia({ trimmed_id, name, video_url })
      if (!inlined && !video_url) return json(res, 400, { error: 'trimmed_id / video_url / name required' })
      const mediaUrl = inlined || video_url
      let transcript = []
      const localVideoPath = trimmed_id ? resolveVideoPath(trimmed_id) : null
      if (localVideoPath) {
        try {
          transcript = await transcribeVideoWithWhisper(localVideoPath)
          console.log(`[asr] whisper ok segments=${transcript.length}`)
        } catch (err) {
          console.warn(`[asr] whisper failed, fallback to multimodal transcription: ${err?.message || err}`)
        }
      }
      if (!transcript.length) {
        const asrResult = await runReverseMedia('asr-transcription', {
          video_url: mediaUrl,
          system: ASR_TRANSCRIPTION_SYSTEM_PROMPT,
          prompt: '请只转写这条视频音轨中的全部可辨人声。无论画面有没有字幕都要识别，严格按 JSON 输出。',
          temperature: 0,
          max_tokens: 4200,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
        }).catch(err => {
          console.warn(`[asr] multimodal transcription failed: ${err?.message || err}`)
          return null
        })
        const asrRaw = asrResult?.choices?.[0]?.message?.content ?? asrResult?.data?.choices?.[0]?.message?.content ?? ''
        transcript = normalizeAsrJson(asrRaw)
      }
      if (transcript.length) {
        transcript = await correctAsrWithVisual(mediaUrl, transcript).catch(err => {
          console.warn(`[asr] visual correction failed, keep audio transcript: ${err?.message || err}`)
          return transcript
        })
      }
      const transcriptContext = transcript.length
        ? `\n\n以下是专用 Whisper ASR 从原音轨识别出的逐字口播（含画外音）。拆镜必须参考这些时间戳；asr_text 必须从对应时间范围逐字复制，不得改写或遗漏：\n${transcript.map(row => `[${row.start.toFixed(2)}-${row.end.toFixed(2)}] ${row.text}`).join('\n').slice(0, 14000)}`
        : '\n\n专用 ASR 未识别到人声；若视频中确实可听见口播，仍须尽力从音轨识别。'
      const data = await runReverseMedia('breakdown-strategy', {
        video_url: mediaUrl,
        system: BREAKDOWN_STRATEGY_SYSTEM_PROMPT_COMPACT,
        prompt: `请对这条参考视频做拆镜拉片分析，严格按 system 里的 JSON 结构输出，不要任何多余文字。务必简洁，避免重复描述。${transcriptContext}`,
        temperature: 0.4,
        max_tokens: 5200,
        response_format: { type: 'json_object' },
        // Seed 2.1 Pro 默认 high 深度思考，长策略会触发模型广场 4 分钟传输超时。
        // 广告拆镜是结构化、受 schema 约束的生产任务，关闭思考换取确定的响应时延。
        thinking: { type: 'disabled' },
      })
      const raw = data?.choices?.[0]?.message?.content ?? data?.data?.choices?.[0]?.message?.content ?? ''
      let normalized = normalizeStrategyJson(raw)
      if (!normalized) {
        console.warn(`[reverse] invalid strategy JSON chars=${String(raw).length} preview=${String(raw).slice(0, 180).replace(/\s+/g, ' ')}`)
        return json(res, 422, { error: '模型返回的策略结构不完整，请重试分析', model: REVERSE_MODEL, raw: String(raw).slice(0, 1200) })
      }
      normalized = applyAsrToStrategy(normalized, transcript)
      console.log(`[reverse] normalized strategy segments=${normalized.segments.length} asr_segments=${transcript.length} raw_chars=${String(raw).length}`)
      return json(res, 200, setResponseContent(data, JSON.stringify(normalized)) )
    }
    // 独立 ASR 修复接口：用于旧任务或浏览器缓存中缺失口播的结果，无需重跑整片视觉反推。
    if (p === '/api/asr/transcribe') {
      const { trimmed_id } = body
      const localVideoPath = trimmed_id ? resolveVideoPath(trimmed_id) : null
      if (!localVideoPath) return json(res, 404, { error: '找不到原视频，请重新上传后识别' })
      const mediaUrl = resolveInlineMedia({ trimmed_id })
      const rawSegments = await transcribeVideoWithWhisper(localVideoPath)
      const segments = await correctAsrWithVisual(mediaUrl, rawSegments).catch(err => {
        console.warn(`[asr] repair visual correction failed, keep audio transcript: ${err?.message || err}`)
        return rawSegments
      })
      console.log(`[asr] repair ok video=${trimmed_id} segments=${segments.length}`)
      return json(res, 200, { ok: true, segments })
    }
    // —— 视频技能创作专家：单个分镜片段 → 完整 .skill.md 文本
    // system prompt 见 skills.mjs（改编自 715-成片skill平台/视频技能创作专家.md）
    if (p === '/api/muse/analyze-shot') {
      const { trimmed_id, video_url, name, model, voiceover_hint } = body
      assertReverseModel(model)
      const inlined = resolveInlineMedia({ trimmed_id, name, video_url })
      if (!inlined && !video_url) return json(res, 400, { error: 'trimmed_id / video_url / name required' })
      const hint = voiceover_hint ? `\n本段口播由独立 ASR 锁定为：「${voiceover_hint}」。不得改写、删减或替换这段文字；只分析画面、动作、运镜和声音氛围，最终生成时由系统原样注入口播。` : ''
      const data = await runReverseMedia('analyze-shot', {
        video_url: inlined || video_url,
        system: ANALYZE_SHOT_SYSTEM_PROMPT_COMPACT,
        prompt: `请分析这个分镜片段，严格按 system 里的固定骨架输出完整 .skill.md 全文，不要任何多余文字。内容简洁但不得遗漏字段。${hint}`,
        temperature: 0.4,
        max_tokens: 3000,
        thinking: { type: 'disabled' },
      })
      return json(res, 200, data)
    }
    if (p === '/api/muse/chat') {
      const { messages, model, temperature, response_format } = body
      if (!messages) return json(res, 400, { error: 'messages required' })
      const data = await chatCompletion({
        model: model || MODELS.chat,
        messages,
        temperature: temperature ?? 0.7,
        response_format,
      })
      return json(res, 200, data)
    }
    if (p === '/api/muse/title') {
      const { context } = body
      if (!context) return json(res, 400, { error: 'context required' })
      const data = await chatCompletion({
        model: REVERSE_MODEL,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: '你是效果广告标题策划。只输出 JSON：{"titles":[{"text":"不超过20个中文字符","tag":"不超过8个中文字符的标题策略"}]}。输出3个差异明显、合规、可直接投放的标题。' },
          { role: 'user', content: `根据以下成片策略生成标题：\n${String(context).slice(0, 6000)}` },
        ],
      })
      return json(res, 200, data)
    }
    if (p === '/api/muse/image') {
      const { prompt, size, aspect_ratio, model, watermark } = body
      if (!prompt) return json(res, 400, { error: 'prompt required' })
      const data = await generateImage({
        model: model || MODELS.image,
        prompt,
        size: size || '1440x2560',
        aspect_ratio: aspect_ratio || '9:16',
        watermark: watermark ?? false,
      })
      return json(res, 200, data)
    }
    if (p === '/api/muse/video/submit') {
      const { prompt, model, duration, aspect_ratio, resolution, sound, generate_audio, reference_images, image_url } = body
      if (!prompt) return json(res, 400, { error: 'prompt required' })
      // Seedance 2.0 按模型广场字段透传 generate_audio/reference_images；旧 image_url 调用
      // 归一化成 reference_images，避免前端历史代码失效。
      const refs = Array.isArray(reference_images) ? reference_images.filter(Boolean) : image_url ? [image_url] : []
      const inlinedRefs = refs.map(inlineTaskReferenceImage)
      const request = {
        model: model || MODELS.video,
        prompt,
        duration: duration ?? 6,
        aspect_ratio: aspect_ratio || '9:16',
        resolution: resolution || '720p',
        sound: sound || (generate_audio === false ? 'off' : 'on'),
        generate_audio: generate_audio ?? true,
        ...(inlinedRefs.length ? { reference_images: inlinedRefs } : {}),
      }
      const generationMode = inlinedRefs.length ? 'r2v' : 't2v'
      let data = generationMode === 'r2v'
        ? await submitReference2Video(request)
        : await submitText2Video(request)
      if (!(data?.data?.task_id || data?.task_id)) console.warn(`[video-generate] submit rejected code=${data?.code ?? 'n/a'} message=${String(data?.message || '').slice(0, 260)}`)
      console.log(`[video-generate] submit mode=${generationMode} model=${model || MODELS.video} duration=${duration ?? 6}s audio=${generate_audio ?? true} refs=${inlinedRefs.length} task=${data?.data?.task_id || data?.task_id || 'missing'} code=${data?.code ?? 'n/a'}`)
      return json(res, 200, data)
    }
    if (p === '/api/muse/video/result') {
      const { task_id } = body
      if (!task_id) return json(res, 400, { error: 'task_id required' })
      const data = await queryText2Video({ task_id })
      const status = data?.data?.task_status || data?.task_status || 'unknown'
      if (!/PROCESSING|PENDING|QUEUED/i.test(status)) console.log(`[video-generate] result task=${task_id} status=${status} code=${data?.data?.huoshan_error_code || data?.code || 'n/a'} url=${Boolean(data?.data?.video_url || data?.video_url)}`)
      return json(res, 200, data)
    }
    if (p === '/api/muse/subtitle-erase/submit') {
      const { video_url } = body
      if (!video_url) return json(res, 400, { error: 'video_url required' })
      return json(res, 200, await submitSubtitleErase({ video_url }))
    }
    if (p === '/api/muse/subtitle-erase/result') {
      const { task_id } = body
      if (!task_id) return json(res, 400, { error: 'task_id required' })
      return json(res, 200, await querySubtitleErase({ task_id }))
    }
    return json(res, 404, { error: `route ${p} not found` })
  } catch (e) {
    console.error('[api error]', p, e)
    const status = e.status || 500
    // 保留固定豆包模型的上游错误。429/5xx 只标注是否可重试，不改写成 Gemini/Vertex 文案，
    // 也不做任何模型降级，确保排障时能看到实际能力与承载协议问题。
    return json(res, status, {
      error: e.message,
      model: p.startsWith('/api/muse/reverse-video') || p.startsWith('/api/muse/breakdown-strategy') || p.startsWith('/api/muse/analyze-shot') ? REVERSE_MODEL : undefined,
      upstreamStatus: status,
      retryable: e.rateLimited || status === 429 || status >= 500,
      body: e.body,
    })
  }
}

export const handler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname).catch(err => { console.error(err); json(res, 500, { error: err.message }) })
  serveStatic(req, res)
}

if (!process.env.VERCEL) {
  const server = http.createServer(handler)
  server.listen(PORT, () => {
    console.log(`[toushi-app] http://0.0.0.0:${PORT}  (api + static dist)`)
    console.log(`[toushi-app] models: ${JSON.stringify(MODELS)}`)
    console.log(`[toushi-app] ffmpeg: ${FFMPEG_BIN}`)
  })
}
