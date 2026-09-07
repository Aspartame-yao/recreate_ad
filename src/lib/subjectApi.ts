import type { Subject, StrategySubject } from '../types'

const BASE: string = (typeof window !== 'undefined' && (window as any).__MUSE_API_BASE__) || ''
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(BASE + path, init); const text = await response.text(); let body: any
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
  return body as T
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) })

export function listSubjects() { return request<{ subjects: Subject[] }>('/api/subjects') }
export function createSubject(input: Partial<Subject>) { return request<Subject>('/api/subjects', json('POST', input)) }
export function updateSubject(id: string, patch: Partial<Subject>) { return request<Subject>(`/api/subjects/${id}`, json('PATCH', patch)) }
export function removeSubject(id: string) { return request<{ ok: boolean }>(`/api/subjects/${id}`, { method: 'DELETE' }) }
export function upsertAnalyzedSubjects(subjects: StrategySubject[]) {
  return request<{ subjects: Subject[]; matched: Subject[] }>('/api/subjects/upsert-analysis', json('POST', { subjects: subjects.map(subject => ({ name: subject.name, type: subject.type, description: subject.description, voice: subject.voice_hint || '', imagePrompt: subject.image_prompt || subject.description, source: 'analysis' })) }))
}
export async function uploadSubjectImage(subjectId: string, file: File) {
  const response = await fetch(`${BASE}/api/subjects/${subjectId}/image-upload`, { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file })
  const body = await response.json(); if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`); return body.subject as Subject
}
export function archiveSubjectImage(subjectId: string, url: string, name: string) { return request<{ subject: Subject }>(`/api/subjects/${subjectId}/archive`, json('POST', { url, name })) }
export function analyzeSubjectImage(image_url: string) { return request<{ description: string; suggested_name?: string; suggested_type?: Subject['type']; voice_hint?: string }>('/api/subjects/analyze', json('POST', { image_url })) }
