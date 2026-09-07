// 保留文件名以兼容现有导入；实现已从 MUSE 网关迁移到火山方舟直连。
import crypto from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const env = key => String(process.env[key] || '').trim()
const ARK_BASE_URL = () => (env('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')
const MEDIAKIT_BASE_URL = () => (env('MEDIAKIT_BASE_URL') || 'https://mediakit.cn-beijing.volces.com').replace(/\/+$/, '')
const MEDIAKIT_SUBMIT_PATH = () => env('MEDIAKIT_SUBMIT_PATH') || '/api/v1/tools/erase-video-subtitle'
const MEDIAKIT_TASK_PATH = () => env('MEDIAKIT_TASK_PATH') || '/api/v1/tasks/{task_id}'
const PLACEHOLDERS = new Set(['your_ark_api_key', 'your_mediakit_api_key', 'changeme', 'xxx', ''])

function requiredKey(name) {
  const value = env(name)
  if (PLACEHOLDERS.has(value)) throw Object.assign(new Error(`${name} 未正确配置`), { status: 500 })
  return value
}

// 兼容旧启动器中的健康检查函数名。
export function getMuseToken() {
  return requiredKey('ARK_API_KEY')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const QUERY_BACKOFF = [1200, 2500, 5000]

function decodeBody(buffer) {
  try {
    return buffer[0] === 0x1f && buffer[1] === 0x8b
      ? gunzipSync(buffer).toString('utf8')
      : buffer.toString('utf8')
  } catch {
    return buffer.toString('utf8')
  }
}

async function providerFetch(url, init = {}, { apiKey, provider = '火山方舟', readOnly = false, retries = 0, timeoutMs = 4 * 60 * 1000 } = {}) {
  const requestId = crypto.randomUUID()
  const maxRetries = readOnly ? retries : 0
  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
        redirect: 'error',
        signal: init.signal || AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      lastError = Object.assign(new Error(`${provider}请求超时或网络中断：${cause?.message || cause}`), {
        status: 504,
        requestId,
      })
      if (attempt < maxRetries) {
        await sleep(QUERY_BACKOFF[Math.min(attempt, QUERY_BACKOFF.length - 1)])
        continue
      }
      throw lastError
    }

    const text = decodeBody(Buffer.from(await response.arrayBuffer()))
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (response.ok && data?.success !== false) return data

    const effectiveStatus = response.ok ? 400 : response.status
    const message = data?.error?.message || data?.message || text || `HTTP ${effectiveStatus}`
    lastError = Object.assign(new Error(`${provider} ${effectiveStatus}: ${String(message).slice(0, 400)}`), {
      status: effectiveStatus,
      body: data,
      requestId,
      rateLimited: effectiveStatus === 429,
    })
    if (attempt < maxRetries && [429, 502, 503, 504].includes(response.status)) {
      await sleep(QUERY_BACKOFF[Math.min(attempt, QUERY_BACKOFF.length - 1)])
      continue
    }
    throw lastError
  }
  throw lastError
}

const arkFetch = (path, init, options = {}) => providerFetch(`${ARK_BASE_URL()}${path}`, init, {
  ...options,
  apiKey: requiredKey('ARK_API_KEY'),
})

const mediaKitFetch = (path, init, options = {}) => providerFetch(`${MEDIAKIT_BASE_URL()}${path}`, init, {
  ...options,
  apiKey: requiredKey('MEDIAKIT_API_KEY'),
  provider: 'AI MediaKit',
})

export async function chatCompletion({ model, messages, temperature, response_format, stream = false, retries, ...extra }) {
  return arkFetch('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model, messages, temperature, response_format, stream, ...extra }),
  })
}

export async function chatWithMedia({ model, prompt, video_url, image_url, temperature, system, retries, ...extra }) {
  const content = [{ type: 'text', text: prompt }]
  if (video_url) content.push({ type: 'video_url', video_url: { url: video_url } })
  else if (image_url) content.push({ type: 'image_url', image_url: { url: image_url } })
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content })
  return chatCompletion({ model, temperature, messages, ...extra })
}

export async function generateImage({ model, prompt, size = '1440x2560', aspect_ratio, watermark = false, ...extra }) {
  return arkFetch('/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model, prompt, size, watermark, ...extra }),
  })
}

function videoContent(prompt, referenceImages = []) {
  return [
    { type: 'text', text: prompt },
    ...referenceImages.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
  ]
}

export async function submitText2Video({ model, prompt, duration, aspect_ratio, resolution, sound, generate_audio, reference_images = [], ...extra }) {
  const data = await arkFetch('/contents/generations/tasks', {
    method: 'POST',
    body: JSON.stringify({
      model,
      content: videoContent(prompt, reference_images),
      duration,
      ratio: aspect_ratio,
      resolution: resolution === '480p' ? '480p' : '720p',
      watermark: extra.watermark ?? false,
      generate_audio: generate_audio ?? sound !== 'off',
    }),
  }, { timeoutMs: 60 * 1000 })
  const taskId = data?.id || data?.task_id
  return { ...data, task_id: taskId, data: { ...(data?.data || {}), task_id: taskId } }
}

export async function submitReference2Video(input) {
  if (!Array.isArray(input?.reference_images) || !input.reference_images.length) {
    throw Object.assign(new Error('R2V 至少需要一张内容参考图'), { status: 400 })
  }
  return submitText2Video(input)
}

export async function queryText2Video({ task_id }) {
  const data = await arkFetch(`/contents/generations/tasks/${encodeURIComponent(task_id)}`, {
    method: 'GET',
  }, { readOnly: true, retries: 3, timeoutMs: 30 * 1000 })
  const status = data?.status || 'unknown'
  const taskStatus = status === 'succeeded' ? 'SUCCEEDED' : status === 'failed' ? 'FAILED' : status.toUpperCase()
  const videoUrl = data?.content?.video_url
  return {
    ...data,
    task_status: taskStatus,
    video_url: videoUrl,
    data: { ...(data?.data || {}), task_status: taskStatus, video_url: videoUrl, content: data?.content },
  }
}

export async function submitSubtitleErase({ video_url }) {
  return mediaKitFetch(MEDIAKIT_SUBMIT_PATH(), {
    method: 'POST',
    body: JSON.stringify({ video_url }),
  }, { timeoutMs: 60 * 1000 })
}

export async function querySubtitleErase({ task_id }) {
  const path = MEDIAKIT_TASK_PATH().replace('{task_id}', encodeURIComponent(task_id))
  const response = await mediaKitFetch(path, { method: 'GET' }, { readOnly: true, retries: 3, timeoutMs: 30 * 1000 })
  const videoUrl = response?.result?.video_url || response?.data?.result?.video_url || response?.video_url || response?.data?.video_url
  return {
    ...response,
    video_url: videoUrl,
    data: {
      ...(response?.data || {}),
      result: response?.data?.result || response?.result,
      video_url: videoUrl,
    },
  }
}
