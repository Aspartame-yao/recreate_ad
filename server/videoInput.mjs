// 40MB 原始文件编码后小于方舟 64MB 请求体上限。
export async function remoteVideoAsDataUrl(url, maxBytes = 40 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(new Error(`读取分析视频失败：HTTP ${response.status}，请重新上传视频`), { status: 502 })
  }
  const tooLarge = () => Object.assign(new Error('分析视频超过 40MB，请裁剪到更短片段后重试'), { status: 413 })
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw tooLarge()
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw tooLarge()
    chunks.push(chunk)
  }
  if (!size) throw Object.assign(new Error('分析视频为空，请重新上传'), { status: 422 })
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim()
  if (contentType && !contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
    throw Object.assign(new Error('视频地址返回了非视频内容，请重新上传'), { status: 422 })
  }
  const mime = contentType.startsWith('video/') ? contentType : 'video/mp4'
  console.log(`[video-input] remote materialized bytes=${size}`)
  return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
}
