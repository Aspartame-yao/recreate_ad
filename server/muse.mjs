// muse.mjs —— 生成 X-MUSE-TOKEN 并封装模型广场调用
// 规范：token = base64("client,unix_seconds_shanghai,sha1(client+client_secret+unix_seconds)")
// 有效期 1200s；服务端保留一份缓存，1000s 内复用。
import crypto from 'node:crypto'
import { gunzipSync } from 'node:zlib'

// ⚠️ 关键：这些值必须在【运行时】读取 process.env，绝不能在模块顶层解构固化。
// 原因：ESM import 会被提升到文件最顶部，muse.mjs 在 index.mjs 调用 loadEnv() 之前
// 就已经被 import 求值了。若顶层 `const { MUSE_CLIENT = '' } = process.env`，那一刻
// .env 尚未加载 → 拿到空串并固化成默认参数 → computeMuseToken 永远报"未配置"。
// 这就是"secret 明明已配置却报未配置"的真凶。改为函数每次现读，彻底规避时序问题。
const env = k => (process.env[k] || '').trim()
const MUSE_LLM_BASE = () => env('MUSE_LLM_BASE') || 'http://30.48.128.77:8080'
const MUSE_MEDIAKIT_BASE = () => env('MUSE_MEDIAKIT_BASE') || 'http://30.48.128.77:8080'

// 占位符集合：从 .env.example 拷贝但没换具体值的常见占位。命中即视为"未完成配置"，
// 给出比"未配置"更精确的提示，方便定位是忘了填还是填错了。
const PLACEHOLDERS = new Set(['your_client_id', 'your_client_secret', 'your-client-id', 'changeme', 'xxx', ''])

let tokenCache = { token: '', bornAt: 0 }

// 上海时区当前 unix 秒。模型广场约定 time 用北京/上海时区，其实 unix 秒本身与时区无关，
// 但文档明确 sign 用 unix 秒。用 Date.now()/1000 即可。
export function nowUnixSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function computeMuseToken(client = env('MUSE_CLIENT'), secret = env('MUSE_CLIENT_SECRET'), t = nowUnixSeconds()) {
  // 精确诊断：区分「完全没填」「还是占位符」两种情况
  const clientBad = PLACEHOLDERS.has(client)
  const secretBad = PLACEHOLDERS.has(secret)
  if (clientBad || secretBad) {
    const which = [clientBad ? 'MUSE_CLIENT' : null, secretBad ? 'MUSE_CLIENT_SECRET' : null].filter(Boolean).join(' / ')
    const detail = client === 'your_client_id' || secret === 'your_client_secret'
      ? '（当前仍是 .env.example 里的占位符，请填写凭证）'
      : '（为空或无效）'
    throw new Error(`${which} 未正确配置${detail}`)
  }
  const sign = crypto.createHash('sha1').update(`${client}${secret}${t}`).digest('hex')
  const raw = `${client},${t},${sign}`
  return Buffer.from(raw, 'utf8').toString('base64')
}

export function getMuseToken() {
  const now = nowUnixSeconds()
  if (tokenCache.token && now - tokenCache.bornAt < 1000) return tokenCache.token
  const token = computeMuseToken()
  tokenCache = { token, bornAt: now }
  return token
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 上游 429（RESOURCE_EXHAUSTED / 配额限流）或 502/503（网关瞬断）是可重试的瞬时错误。
// gemini video 在测试环境配额有限，遇到就指数退避重试，避免偶发限流直接失败。
function isTransient(status, text) {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true
  return /RESOURCE_EXHAUSTED|Error 429|try again later|exhausted/i.test(text || '')
}
function isRateLimited(status, text) {
  return status === 429 || /RESOURCE_EXHAUSTED|Error 429|exhausted/i.test(text || '')
}
// 从响应体/头里解析 Retry-After（秒）。网关有时把建议等待时间放在 message 里。
function parseRetryAfter(res, text) {
  const h = res.headers?.get?.('retry-after')
  if (h && !isNaN(+h)) return Math.min(+h, 60)
  const m = /retry.{0,6}?(\d{1,3})\s*(s|sec|seconds|秒)/i.exec(text || '')
  if (m) return Math.min(+m[1], 60)
  return 0
}

// 429（配额）专用退避阶梯：比普通瞬时错误更耐心。单位 ms，带随机抖动避免多请求同时重试撞车。
const RATE_BACKOFF = [4000, 8000, 15000, 25000, 40000, 40000, 40000, 40000]
// 瞬时错误（502/503/504/EOF）退避阶梯。多模态视频调用（reverse-video/breakdown-strategy/
// analyze-shot）实测会遇到 Vertex AI 网关连续 502 "unexpected EOF" 长达 20~30 分钟的整段抖动
// （2026-07-16 观测到 11:05~11:35 持续失败），默认 5 次重试（累计等待 ~36s）远远不够撑过这种
// 整段窗口。加长阶梯 + 提高默认重试次数（见 museFetch 的 retries 默认值），让服务端自己扛住
// 大部分瞬断，而不是把"稍后再试"甩给用户。
const TRANSIENT_BACKOFF = [1500, 3000, 6000, 10000, 15000, 20000, 25000, 30000, 30000, 30000]

async function museFetch(url, init = {}, { retries = 8, timeoutMs = 4 * 60 * 1000 } = {}) {
  let requestModel = ''
  try { requestModel = JSON.parse(String(init.body || '{}'))?.model || '' } catch {}
  const headers = {
    'X-MUSE-TOKEN': getMuseToken(),
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  }
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      res = await fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(timeoutMs) })
    } catch (cause) {
      lastErr = new Error(`muse-gateway 请求超时或网络中断：${cause?.message || cause}`)
      lastErr.status = 504
      if (attempt < retries) {
        const wait = TRANSIENT_BACKOFF[Math.min(attempt, TRANSIENT_BACKOFF.length - 1)]
        console.warn(`[muse] model=${requestModel || 'unknown'} network timeout · 第${attempt + 1}/${retries}次重试，等待 ${(wait / 1000).toFixed(1)}s`)
        await sleep(wait)
        continue
      }
      throw lastErr
    }
    const responseBytes = Buffer.from(await res.arrayBuffer())
    // MediaKit 网关偶尔返回 gzip 字节却漏掉 Content-Encoding，fetch 不会自动解压。
    // 检测 gzip magic，确保字幕擦除等接口仍能得到正常 JSON。
    let text
    try {
      text = responseBytes[0] === 0x1f && responseBytes[1] === 0x8b
        ? gunzipSync(responseBytes).toString('utf8')
        : responseBytes.toString('utf8')
    } catch {
      text = responseBytes.toString('utf8')
    }
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    if (res.ok) return data
    if (attempt < retries && isTransient(res.status, text)) {
      const limited = isRateLimited(res.status, text)
      const ladder = limited ? RATE_BACKOFF : TRANSIENT_BACKOFF
      // 优先尊重网关给出的 Retry-After；否则走退避阶梯
      const suggested = parseRetryAfter(res, text) * 1000
      const base = suggested || ladder[Math.min(attempt, ladder.length - 1)]
      const jitter = Math.floor(Math.random() * 800) // 0~800ms 抖动
      const wait = base + jitter
      console.warn(`[muse] model=${requestModel || 'unknown'} ${res.status} ${limited ? 'RATE_LIMIT' : 'transient'} · 第${attempt + 1}/${retries}次重试，等待 ${(wait / 1000).toFixed(1)}s`)
      await sleep(wait)
      continue
    }
    const err = new Error(`muse-gateway ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    err.rateLimited = isRateLimited(res.status, text)
    err.body = data
    lastErr = err
    throw err
  }
  throw lastErr
}

// —— 对话（MUSE OpenAI-compatible chat/completions）
// retries 可选覆盖；视频反推固定使用豆包 2.1 Pro，只重试同一模型，不做任何模型降级。
export async function chatCompletion({ model, messages, temperature, response_format, stream = false, retries, ...extra }) {
  // GPT-5 系列在当前 MUSE 网关只接受默认 temperature=1；传 0/0.7 会直接 400。
  const safeTemperature = /^gpt-5(?:\.|-|$)/i.test(String(model || '')) ? 1 : temperature
  return museFetch(`${MUSE_LLM_BASE()}/llm/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model, messages, temperature: safeTemperature, response_format, stream, ...extra }),
  }, retries != null ? { retries } : undefined)
}

// —— 视频/图片理解（走 MUSE OpenAI-compatible chat + 多模态消息）
// doubao-seed-2-1-pro-260628 实测要求视频使用 content[].type="video_url"，并支持
// video_url.url="data:video/mp4;base64,..."；如果误放到 image_url 会报 Invalid base64 image_url。
// 图片继续使用标准 image_url。两者不可混用。
export async function chatWithMedia({ model, prompt, video_url, image_url, temperature, system, retries, ...extra }) {
  const content = [{ type: 'text', text: prompt }]
  if (video_url) content.push({ type: 'video_url', video_url: { url: video_url } })
  else if (image_url) content.push({ type: 'image_url', image_url: { url: image_url } })
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content })
  return chatCompletion({ model, temperature, messages, retries, ...extra })
}

// —— 图片生成（模型广场统一 OpenAI-compatible 图片入口）
export async function generateImage({ model, prompt, size = '1440x2560', aspect_ratio = '1:1', watermark = false, ...extra }) {
  return museFetch(`${MUSE_LLM_BASE()}/llm/v1/images/generate`, {
    method: 'POST',
    body: JSON.stringify({ model, prompt, size, aspect_ratio, watermark, ...extra }),
  })
}

// —— 文生视频提交（seedance / kling / sora / hunyuan 通用，走 llm/v1/videos）
export async function submitText2Video({ model, prompt, duration, aspect_ratio, resolution, sound, ...extra }) {
  return museFetch(`${MUSE_LLM_BASE()}/llm/v1/videos/text2video/submit`, {
    method: 'POST',
    body: JSON.stringify({ model, prompt, duration, aspect_ratio, resolution, sound, ...extra }),
  }, { retries: 2, timeoutMs: 30 * 1000 })
}

// MUSE 当前将 Seedance 2.0 的 T2V/R2V 统一承载在 text2video RPC；
// 是否进入 R2V 由 reference_images 内容数组决定。独立的 reference2video/r2v RPC 不存在。
export async function submitReference2Video(input) {
  if (!Array.isArray(input?.reference_images) || !input.reference_images.length) {
    throw Object.assign(new Error('R2V 至少需要一张内容参考图'), { status: 400 })
  }
  return submitText2Video(input)
}

// —— 文生视频查询
export async function queryText2Video({ task_id }) {
  return museFetch(`${MUSE_LLM_BASE()}/llm/v1/videos/text2video/result`, {
    method: 'POST',
    body: JSON.stringify({ task_id }),
  })
}

// —— 字幕擦除（AI MediaKit）
// 注意：AI MediaKit 原生走 Bearer $ARK_API_KEY，模型广场包了一层用 X-MUSE-TOKEN 转发
export async function submitSubtitleErase({ video_url }) {
  return museFetch(`${MUSE_MEDIAKIT_BASE()}/muse_ai_proxy/volcengine-mediakit/api/v1/ark-tools/ark-erase-video-subtitle-pro`, {
    method: 'POST',
    body: JSON.stringify({ video_url }),
  })
}

export async function querySubtitleErase({ task_id }) {
  return museFetch(`${MUSE_MEDIAKIT_BASE()}/muse_ai_proxy/volcengine-mediakit/api/v1/ark-tasks/${encodeURIComponent(task_id)}`, {
    method: 'GET',
  })
}
