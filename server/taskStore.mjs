import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

// HOME 在桌面沙箱/只读容器中不一定可写；默认落系统临时目录，亦可用环境变量覆盖。
const DATA_DIR = process.env.TOUSHI_DATA_DIR || path.join(os.tmpdir(), 'toushi-app-data')
const TASK_DIR = path.join(DATA_DIR, 'tasks')
const MEDIA_DIR = path.join(DATA_DIR, 'media')
fs.mkdirSync(TASK_DIR, { recursive: true })
fs.mkdirSync(MEDIA_DIR, { recursive: true })

const safeId = value => /^[A-Za-z0-9_-]{8,80}$/.test(String(value || '')) ? String(value) : null
const taskFile = id => path.join(TASK_DIR, `${id}.json`)
const mediaTaskDir = id => path.join(MEDIA_DIR, id)
const makeId = () => crypto.randomBytes(16).toString('base64url')
const safeName = name => path.basename(String(name || 'asset')).replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 100) || 'asset'

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
function sanitizeSnapshot(snapshot) {
  const cloned = JSON.parse(JSON.stringify(snapshot || {}))
  if (cloned.toast) cloned.toast = null
  if (cloned.source?.objectUrl?.startsWith?.('blob:')) cloned.source.objectUrl = null
  if (Array.isArray(cloned.shots)) {
    for (const shot of cloned.shots) {
      if (Array.isArray(shot.refs)) shot.refs = shot.refs.filter(ref => !String(ref?.url || '').startsWith('blob:'))
    }
  }
  if (Array.isArray(cloned.compose?.audios)) cloned.compose.audios = cloned.compose.audios.filter(a => !String(a?.url || '').startsWith('blob:'))
  return cloned
}
export function createTask({ name = '未命名任务', snapshot = {} } = {}) {
  const id = makeId(); const now = new Date().toISOString()
  const task = { id, name: String(name).slice(0, 80), createdAt: now, updatedAt: now, snapshot: sanitizeSnapshot(snapshot) }
  atomicWrite(taskFile(id), task)
  return task
}
export function getTask(id) {
  const safe = safeId(id); if (!safe || !fs.existsSync(taskFile(safe))) return null
  try { return JSON.parse(fs.readFileSync(taskFile(safe), 'utf8')) } catch { return null }
}
export function listTasks() {
  try {
    return fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8'))
        return { id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt, step: t.snapshot?.step || 0, shots: t.snapshot?.shots?.length || 0, preview: t.snapshot?.compose?.renderedVideoUrl || t.snapshot?.shots?.find?.(s => s.videoUrl)?.videoUrl || null }
      } catch { return null }
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  } catch { return [] }
}
export function updateTask(id, { name, snapshot } = {}) {
  const task = getTask(id); if (!task) return null
  if (name != null) task.name = String(name).slice(0, 80)
  if (snapshot != null) task.snapshot = sanitizeSnapshot(snapshot)
  task.updatedAt = new Date().toISOString()
  atomicWrite(taskFile(task.id), task)
  return task
}
export function deleteTask(id) {
  const safe = safeId(id); if (!safe || !fs.existsSync(taskFile(safe))) return false
  try { fs.unlinkSync(taskFile(safe)); fs.rmSync(mediaTaskDir(safe), { recursive: true, force: true }); return true } catch { return false }
}
export function saveTaskMedia(id, originalName, buffer) {
  const safe = safeId(id); if (!safe) throw new Error('任务 ID 不合法')
  const dir = mediaTaskDir(safe); fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(safeName(originalName)) || ''
  const file = `${makeId()}${ext}`
  const dest = path.join(dir, file)
  fs.writeFileSync(dest, buffer)
  return { file, path: dest, bytes: buffer.length, name: safeName(originalName) }
}
export function taskMediaPath(id, file) {
  const safe = safeId(id); const safeFile = safeName(file)
  if (!safe || !safeFile) return null
  const candidate = path.join(mediaTaskDir(safe), safeFile)
  return candidate.startsWith(mediaTaskDir(safe)) && fs.existsSync(candidate) ? candidate : null
}
export function taskMediaUrl(id, file) { return `/api/task-media/${id}/${encodeURIComponent(file)}` }
