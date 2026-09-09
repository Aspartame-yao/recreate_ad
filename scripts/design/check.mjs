import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = fs.readFileSync('src/design-tokens.css', 'utf8');
const tokens = Object.fromEntries([...root.matchAll(/--ds-([\w-]+):\s*(#[\da-f]{6})/gi)].map(m => [m[1], m[2]]));
function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
function contrast(a,b) { const x=luminance(tokens[a]),y=luminance(tokens[b]);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
for (const bg of ['canvas','surface','surface-raised']) for (const fg of ['text','text-secondary','text-muted','error','warning','success']) assert(contrast(fg,bg)>=4.5, `${fg}/${bg} contrast below 4.5`);
for (const bg of ['blue','violet']) assert(contrast('white',bg)>=4.5, `Primary gradient ${bg} contrast below 4.5`);
for (const file of ['src/tokens.css','src/design-system.css']) {
  const css=fs.readFileSync(file,'utf8');
  assert(!/#[\da-f]{3,8}\b|rgba?\(|oklch\(/i.test(css), `${file}: use semantic colors`);
  for(const m of css.matchAll(/var\(--ds-([\w-]+)/g)) assert(tokens[m[1]], `Unknown token ${m[1]}`);
}
console.log(`Design system: ${Object.keys(tokens).length} colors; semantic references and 18 text contrast pairs passed.`);
