import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// Evaluate the actual reducer without React/browser side effects.
const source = readFileSync(new URL('../../src/store.tsx', import.meta.url), 'utf8');
const reducerSource = source.slice(source.indexOf('function reducer('), source.indexOf('const Ctx ='));
const context = vm.createContext({});
vm.runInContext(ts.transpile(reducerSource, { target: ts.ScriptTarget.ES2022 }), context);
const base = { shots: [{ id: 'a' }, { id: 'b' }], compose: { renderedVideoUrl: 'old.mp4', renderStatus: 'done', audios: [{ id: 'audio' }], subs: [{ id: 'sub' }] } };
let state = context.reducer(base, { type: 'toggleCompositionShot', id: 'a' });
assert.equal(state.shots.length, 2, 'Removing from timeline must preserve source shots');
assert.equal(state.shots.filter(s => !state.compose.excludedShotIds.includes(s.id)).length, 1);
assert.equal(state.compose.renderedVideoUrl, undefined);
state = context.reducer(state, { type: 'toggleCompositionShot', id: 'a' });
assert.equal(state.compose.excludedShotIds.length, 0);
for (const [type, id, field] of [['delAudio', 'audio', 'audios'], ['delSub', 'sub', 'subs']]) {
  const next = context.reducer(base, { type, id });
  assert.equal(next.compose[field].length, 0);
  assert.equal(next.compose.renderedVideoUrl, undefined, 'Deleted media must invalidate old render');
  assert.equal(next.compose.renderStatus, 'idle');
}
assert.equal(base.compose.audios.length, 1, 'Prior state must remain unchanged');
console.log('Composition deletion, restoration and render invalidation passed.');
