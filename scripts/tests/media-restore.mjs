import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toushi-media-test-'));
process.env.TOUSHI_DATA_DIR = dir;
try {
  const store = await import('../../server/taskStore.mjs');
  const source = 'https://example.invalid/expired.jpg';
  const task = store.createTask({ snapshot: { covers: [{ url: source }] } });
  const asset = store.saveTaskMedia(task.id, 'cover.jpg', Buffer.from('test'));
  fs.writeFileSync(asset.path + '.source.json', JSON.stringify({ source_url: source }));
  const url = store.taskMediaUrl(task.id, asset.file);
  assert.equal(store.getTask(task.id).snapshot.covers[0].url, url);
  assert.equal(store.updateTask(task.id, { snapshot: { covers: [{ url: source }], shots: [{ processedVideoUrl: source }] } }).snapshot.shots[0].processedVideoUrl, url);
  fs.unlinkSync(asset.path);
  assert.equal(store.updateTask(task.id, { snapshot: { covers: [{ url: source }] } }).snapshot.covers[0].url, source);
  console.log('Archived URL restoration and missing-file fallback passed.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
