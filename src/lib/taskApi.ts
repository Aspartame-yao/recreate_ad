import type { AppState, RefImage } from '../types'

const BASE: string = (typeof window !== 'undefined' && (window as any).__MUSE_API_BASE__) || ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!res.ok) throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status, body })
  return body as T
}

export interface TaskSummary { id: string; name: string; createdAt: string; updatedAt: string; step: number; shots: number; preview: string | null }
export interface StoredTask { id: string; name: string; createdAt: string; updatedAt: string; snapshot: AppState }

export function listTasks() { return request<{ tasks: TaskSummary[] }>('/api/tasks') }
export function getTask(id: string) { return request<StoredTask>(`/api/tasks/${id}`) }
export function createTask(name: string, snapshot: Partial<AppState>) {
  return request<StoredTask>('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, snapshot }) })
}
export function saveTask(id: string, name: string, snapshot: Partial<AppState>) {
  return request<StoredTask>(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, snapshot }) })
}
export function removeTask(id: string) { return request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }) }

export async function uploadTaskReference(taskId: string, file: File): Promise<RefImage> {
  if (!file.type.match(/^image\/(png|jpeg|webp|gif)$/)) throw new Error('仅支持 PNG、JPG、WebP 或 GIF 商品参考图')
  if (file.size > 20 * 1024 * 1024) throw new Error('单张参考图不能超过 20MB')
  const res = await fetch(`${BASE}/api/tasks/${taskId}/reference-upload`, { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file })
  const text = await res.text(); let body: any
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!res.ok) throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status, body })
  return { id: body.id, name: body.name, url: body.url, publicUrl: body.public_url }
}
export async function archiveTaskMedia(taskId: string, url: string, name: string): Promise<{ url: string; publicUrl: string }> {
  const body = await request<any>(`/api/tasks/${taskId}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, name }) })
  return { url: body.url, publicUrl: body.public_url }
}
