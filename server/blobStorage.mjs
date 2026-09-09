import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { put } from '@vercel/blob'
import { handleUpload } from '@vercel/blob/client'

const mediaToken = () => process.env.MEDIA_READ_WRITE_TOKEN || (process.env.BLOB_ACCESS === 'public' ? process.env.BLOB_READ_WRITE_TOKEN : '')
export const blobConfigured = () => Boolean(mediaToken())
export const blobAccess = () => process.env.MEDIA_READ_WRITE_TOKEN || process.env.BLOB_ACCESS === 'public' ? 'public' : 'private'
export async function issueMediaUpload(req, body, user) {
  if (!user) throw Object.assign(new Error('请先登录'), { status: 401 })
  if (!blobConfigured()) throw Object.assign(new Error('文件存储尚未配置'), { status: 503 })
  if (body?.type !== 'blob.generate-client-token') throw Object.assign(new Error('无效的上传请求'), { status: 400 })
  return handleUpload({ token: mediaToken(), request: req, body, onBeforeGenerateToken: async pathname => {
    if (!/^media\/[a-f0-9-]{36}\/[\w.-]+$/.test(pathname)) throw new Error('无效的文件路径')
    return { allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp'], maximumSizeInBytes: 200 * 1024 * 1024, validUntil: Date.now() + 30 * 60 * 1000, addRandomSuffix: true, allowOverwrite: false }
  } })
}
export async function persistMedia(file, name = path.basename(file)) {
  if (!blobConfigured()) return ''
  // Public media is enabled only after explicitly configuring the connected store.
  if (blobAccess() !== 'public') throw new Error('请先配置媒体存储访问方式')
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const result = await put(`media/${crypto.randomUUID()}/${safeName}`, fs.createReadStream(file), { token: mediaToken(), access: 'public', addRandomSuffix: true, multipart: true })
  return result.url
}
