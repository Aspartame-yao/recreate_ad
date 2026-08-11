// 从模型返回中抽取严格 JSON。
// 处理常见坏情况：
//   1) 裹着 ```json ... ``` fence
//   2) 前后有"以下是您需要的分析结果："等废话
//   3) 中间嵌 // 或 /* */ 注释（一些模型会加）
//   4) 尾巴多逗号（trailing comma）
//   5) 中英文/全角引号混用
// 找到最外层平衡的 `{...}` 或 `[...]`，再逐步清洗。

export function extractJson<T = any>(raw: string): T | null {
  if (!raw) return null
  let s = String(raw)

  // 1) 剥 markdown fence
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1]

  // 2) 找第一个 { 或 [
  const startObj = s.indexOf('{')
  const startArr = s.indexOf('[')
  let start = -1
  let openCh = ''
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) { start = startObj; openCh = '{' }
  else if (startArr >= 0) { start = startArr; openCh = '['; }
  if (start < 0) return null
  const closeCh = openCh === '{' ? '}' : ']'

  // 3) 平衡括号，同时考虑字符串内的转义
  let depth = 0
  let inStr = false
  let strCh: string = ''
  let escape = false
  let end = -1
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (escape) { escape = false }
      else if (c === '\\') { escape = true }
      else if (c === strCh) { inStr = false }
      continue
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null
  let block = s.slice(start, end + 1)

  // 4) 清洗
  block = block
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* */ 注释
    .replace(/(^|[^:\/])\/\/[^\n\r]*/g, '$1') // // 行注释
    .replace(/[""]/g, '"')  // 中文双引号
    .replace(/['']/g, "'")  // 中文单引号
    .replace(/,(\s*[}\]])/g, '$1') // trailing comma

  // 5) 若外层是单引号包 key/value，粗略换成双引号（保守：只在没被双引号包住时）
  //   这一步只兜底 JS-style 对象字面量。
  try { return JSON.parse(block) as T } catch { /* fallthrough */ }
  try {
    const relaxed = block.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`)
    return JSON.parse(relaxed) as T
  } catch { return null }
}
