// 《策略skill》（拆镜拉片专家）与单镜头 .skill.md（视频技能创作专家）的解析/渲染工具
import type { StrategySkillJson } from '../types'

// mm:ss → 秒
export function mmssToSec(s: string): number {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(s || '').trim())
  if (!m) return 0
  return (+m[1]) * 60 + (+m[2])
}
// 秒 → mm:ss
export function secToMmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// 把《策略skill》结构化 JSON 渲染成 SKILL.md 形式的文本（frontmatter + json 代码块 + 人读小结），
// 与《拆镜拉片专家》产出的文件格式一致，供 UI 直接展示"md 结果"。
export function buildStrategySkillMd(j: StrategySkillJson): string {
  const name = `${j.meta?.title || '参考片'}同款分镜策略`
  const desc = `复刻《${j.meta?.title || '参考片'}》：${j.strategy?.core_selling_point || ''}`.slice(0, 160)
  const segLines = (j.segments || []).map(s =>
    `${s.index}. \`${s.start}–${s.end}\`（${s.duration}s · ${s.role}）${s.role_note || ''}\n   - 画面：${s.visual}\n   - 口播：${s.voiceover_script}`
  ).join('\n')
  return `---
name: ${name}
description: "由拆镜拉片专家分析参考片生成，含成片策略与拆镜时间轴（每段5/10/15s）+每段默认口播"
agent_created: true
---

# ${name}

> 由《拆镜拉片专家》从参考片拉片生成。共 ${j.meta?.segment_count ?? (j.segments || []).length} 段，总时长 ${j.meta?.total_duration_s ?? ''}s，套路：${j.meta?.routine || ''}。

## 成片策略
- **核心卖点**：${j.strategy?.core_selling_point || ''}
- **表达方式**：${j.strategy?.expression_style || ''}
- **镜头组织逻辑**：${j.strategy?.shot_logic || ''}
- **叙事结构**：${j.strategy?.narrative_structure || ''}
- **吸睛钩子**：前贴 ${j.strategy?.attention_hooks?.pre_roll || ''} · 中插 ${j.strategy?.attention_hooks?.mid_roll || ''} · 尾贴 ${j.strategy?.attention_hooks?.end_roll || ''}

## 拆镜时间轴（${(j.segments || []).length} 段）
${segLines}

## 复刻要点
- 锚点：${(j.remake?.anchors || []).join(' / ')}
- 可替换变量：${(j.remake?.variables || []).join(' / ')}
- 注意：${(j.remake?.cautions || []).join(' / ')}

\`\`\`json
${JSON.stringify(j, null, 2)}
\`\`\`
`
}

// 从「视频技能创作专家」返回的完整 .skill.md 文本里解析出 JSON 头部字段
export interface ParsedShotSkill {
  id?: string; name?: string; shortTitle?: string; tagline?: string; description?: string
  visualPrompt?: string; motionPrompt?: string; negativePrompt?: string
  requiresImage?: boolean; keywords?: string[]
}
export function parseShotSkillMd(md: string): ParsedShotSkill | null {
  if (!md) return null
  const m = /---json\s*([\s\S]*?)\s*---/.exec(md)
  if (!m) return null
  try {
    const j = JSON.parse(m[1])
    return {
      id: j.id, name: j.name, shortTitle: j.short_title, tagline: j.tagline, description: j.description,
      visualPrompt: j.visual_prompt, motionPrompt: j.motion_prompt, negativePrompt: j.negative_prompt,
      requiresImage: !!j.requires_image, keywords: j.keywords,
    }
  } catch { return null }
}

// 把逐镜反推得到的三段专业结论，组合成 Seedance 可编辑生成提示词。
// 口播会直接交给 Seedance 生成声音（generate_audio:true），不是只做节奏参考。
export function buildShotGenerationPrompt(parsed: ParsedShotSkill, voiceover: string): string {
  return [
    `【画面与视觉风格】\n${String(parsed.visualPrompt || '').trim()}`,
    `【主体动作、运镜与节奏】\n${String(parsed.motionPrompt || '').trim()}`,
    `【必须避免】\n${String(parsed.negativePrompt || '').trim()}`,
    `【口播与声音设计】\n角色用自然中文完整说出：「${String(voiceover || '').trim()}」。口型、情绪、动作节奏与口播同步；保留贴合画面的环境音与轻量音效，不添加无关旁白。`,
  ].join('\n\n')
}
