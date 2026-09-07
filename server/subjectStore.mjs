import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

const DATA_DIR = process.env.TOUSHI_DATA_DIR || path.join(os.tmpdir(), 'toushi-app-data')
const SUBJECT_DIR = path.join(DATA_DIR, 'subjects')
const MEDIA_DIR = path.join(SUBJECT_DIR, 'media')
const INDEX_FILE = path.join(SUBJECT_DIR, 'index.json')
fs.mkdirSync(MEDIA_DIR, { recursive: true })

const makeId = () => crypto.randomBytes(16).toString('base64url')
const safeId = value => /^[A-Za-z0-9_-]{8,80}$/.test(String(value || '')) ? String(value) : null
const safeName = name => path.basename(String(name || 'asset')).replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 100) || 'asset'
const normalizeType = type => ['person', 'product', 'scene', 'other'].includes(type) ? type : 'other'

function readAll() {
  try { const value = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); return Array.isArray(value) ? value : [] } catch { return [] }
}
function writeAll(subjects) {
  const temp = `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(subjects, null, 2), 'utf8'); fs.renameSync(temp, INDEX_FILE)
}
function normalize(subject, existing = {}) {
  const now = new Date().toISOString()
  return {
    id: existing.id || safeId(subject?.id) || makeId(),
    name: String(subject?.name ?? existing.name ?? '').slice(0, 30),
    type: normalizeType(subject?.type ?? existing.type),
    description: String(subject?.description ?? existing.description ?? '').slice(0, 600),
    voice: String(subject?.voice ?? existing.voice ?? '').slice(0, 300),
    imagePrompt: String(subject?.imagePrompt ?? existing.imagePrompt ?? '').slice(0, 800),
    images: Array.isArray(subject?.images) ? subject.images.slice(0, 3) : (existing.images || []).slice(0, 3),
    recommended: subject?.recommended ?? existing.recommended ?? true,
    source: subject?.source === 'analysis' || existing.source === 'analysis' ? 'analysis' : 'user',
    createdAt: existing.createdAt || now, updatedAt: now,
  }
}
export function listSubjects() { return readAll().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) }
export function getSubject(id) { const safe = safeId(id); return safe ? readAll().find(item => item.id === safe) || null : null }
export function createSubject(input = {}) { const subjects = readAll(); const subject = normalize(input); subjects.push(subject); writeAll(subjects); return subject }
export function updateSubject(id, patch = {}) { const subjects = readAll(); const index = subjects.findIndex(item => item.id === safeId(id)); if (index < 0) return null; subjects[index] = normalize(patch, subjects[index]); writeAll(subjects); return subjects[index] }
export function deleteSubject(id) { const safe = safeId(id); const subjects = readAll(); const next = subjects.filter(item => item.id !== safe); if (next.length === subjects.length) return false; writeAll(next); try { fs.rmSync(path.join(MEDIA_DIR, safe), { recursive: true, force: true }) } catch {}; return true }
export function upsertAnalyzedSubjects(candidates = []) {
  let subjects = readAll()
  const result = []
  for (const candidate of candidates.slice(0, 20)) {
    const name = String(candidate?.name || '').trim().slice(0, 30); if (!name) continue
    const index = subjects.findIndex(item => item.name.trim().toLowerCase() === name.toLowerCase())
    if (index >= 0) {
      const existing = subjects[index]
      subjects[index] = normalize({ ...candidate, images: existing.images, source: existing.source, recommended: existing.recommended, description: existing.description || candidate.description, voice: existing.voice || candidate.voice }, existing)
      result.push(subjects[index])
    } else {
      const subject = normalize({ ...candidate, source: 'analysis' }); subjects.push(subject); result.push(subject)
    }
  }
  writeAll(subjects); return { subjects, matched: result }
}
export function saveSubjectMedia(id, originalName, buffer) {
  const safe = safeId(id); if (!safe || !getSubject(safe)) throw new Error('主体不存在')
  const dir = path.join(MEDIA_DIR, safe); fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(safeName(originalName)) || '.jpg'; const file = `${makeId()}${ext}`; const dest = path.join(dir, file)
  fs.writeFileSync(dest, buffer); return { file, path: dest, bytes: buffer.length, name: safeName(originalName) }
}
export function subjectMediaPath(id, file) { const safe = safeId(id); if (!safe) return null; const dir = path.join(MEDIA_DIR, safe); const candidate = path.join(dir, safeName(file)); return candidate.startsWith(dir) && fs.existsSync(candidate) ? candidate : null }
export function subjectMediaUrl(id, file) { return `/api/subject-media/${id}/${encodeURIComponent(file)}` }
