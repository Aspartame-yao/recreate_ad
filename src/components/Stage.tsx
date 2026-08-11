import { useStore, useToast, STEPS } from '../store'
import { Step1Reverse } from '../steps/Step1Reverse'
import { Step2Replicate } from '../steps/Step2Replicate'
import { Step3Process, Step4Compose, Step5Cover } from '../steps/StepsRest'
import { ArrowLeft, ArrowRight, Download } from 'lucide-react'

const FOOTS = [
  ['准备生成你的版本', '继续：视频复刻'],
  ['准备整理生成素材', '继续：视频处理'],
  ['准备编排完整故事', '继续：合成成片'],
  ['准备包装发布物料', '继续：封面标题'],
  ['作品已经准备完成', '导出完整作品'],
]
const MAX = STEPS.length - 1
const DESCRIPTIONS = [
  '上传一条参考视频，AI 会提炼它的钩子、节奏、文案和镜头结构。',
  '逐镜调整创意与素材，让爆款方法自然变成你的品牌内容。',
  '统一处理画面元素，为后续合成准备干净、可用的镜头。',
  '在时间轴上整理视频、声音与字幕，完成最终叙事节奏。',
  '生成封面与标题，整理成可直接发布的完整交付包。',
]

export function Stage() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const i = state.step
  const s = STEPS[i]
  const body = [<Step1Reverse />, <Step2Replicate />, <Step3Process />, <Step4Compose />, <Step5Cover />][i]
  const f = FOOTS[i]
  const progress = ((i + 1) / STEPS.length) * 100

  const go = (d: number) => {
    const n = i + d
    if (n < 0 || n > MAX) { toast('流程完成 · 交付包已导出'); return }
    dispatch({ type: 'goStep', step: n })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <>
      <main className={`stage stage--${s.code.toLowerCase()}`}><div className="wrap">
        <div className="stage-head">
          <div className="stage-heading-copy"><span className="stage-no">第 {i + 1} 步，共 {STEPS.length} 步</span><span className="stage-title">{s.nm}</span><p>{DESCRIPTIONS[i]}</p></div>
          <span className="stage-state"><i /> 已自动保存</span>
        </div>
        <div className="thick-rule"><i style={{ width: `${progress}%` }} /></div>
        {body}
      </div></main>
      <div className="foot"><div className="wrap"><div className="foot-in">
        <div><div className="foot-txt">{f[0]}</div></div>
        <div style={{ display: 'flex', gap: 12 }}>
          {i > 0 && <button className="btn btn--ghost btn-with-icon" onClick={() => go(-1)}><ArrowLeft size={15} />上一步</button>}
          <button className="btn btn--primary btn-with-icon" style={{ padding: '11px 20px' }} onClick={() => go(1)}>{i === MAX ? <Download size={15} /> : null}{f[1]}{i !== MAX ? <ArrowRight size={15} /> : null}</button>
        </div>
      </div></div></div>
      <div className="colophon"><div className="wrap"><div className="colophon-in">
        <span>他山之石 · AI 广告创作工作台</span>
        <span>REVERSE · REPLICATE · PROCESS · COMPOSE · COVER</span>
      </div></div></div>
    </>
  )
}
