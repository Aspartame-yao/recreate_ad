import assert from 'node:assert/strict'
import { remoteVideoAsDataUrl } from '../../server/videoInput.mjs'
const original = globalThis.fetch
try {
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })
  assert.equal(await remoteVideoAsDataUrl('https://example.com/video'), 'data:video/mp4;base64,AQID')
  await assert.rejects(remoteVideoAsDataUrl('https://example.com/video', 2), { status: 413 })
  globalThis.fetch = async () => new Response('expired', { status: 404 })
  await assert.rejects(remoteVideoAsDataUrl('https://example.com/video'), { status: 502 })
  globalThis.fetch = async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })
  await assert.rejects(remoteVideoAsDataUrl('https://example.com/video'), { status: 422 })
  globalThis.fetch = async () => new Response(new Uint8Array())
  await assert.rejects(remoteVideoAsDataUrl('https://example.com/video'), { status: 422 })
  console.log('video input checks passed')
} finally { globalThis.fetch = original }
