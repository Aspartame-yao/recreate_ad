export interface AuthUser { username: string }

async function authRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, credentials: 'same-origin' })
  const text = await response.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { error: text || `HTTP ${response.status}` } }
  if (!response.ok) throw Object.assign(new Error(body?.error || `HTTP ${response.status}`), { status: response.status, body })
  return body
}

export async function getSession(): Promise<AuthUser | null> {
  try { return (await authRequest('/api/auth/session')).user || null }
  catch (error: any) { if (error?.status === 401) return null; throw error }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const body = await authRequest('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  })
  return body.user
}

export async function logout() { await authRequest('/api/auth/logout', { method: 'POST' }) }
