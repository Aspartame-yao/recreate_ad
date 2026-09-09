import { useStore, STEPS } from '../store'
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

export function Stage() {
  const { state, dispatch } = useStore()
  const i = state.step
  const s = STEPS[i]
  const body = [<Step1Reverse />, <Step2Replicate />, <Step3Process />, <Step4Compose />, <Step5Cover />][i]
  const f = FOOTS[i]

  const go = (d: number) => {
    const n = i + d
    if (n < 0) return
    if (n > MAX) { window.dispatchEvent(new Event('toushi:export')); return }
    dispatch({ type: 'goStep', step: n })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <>
      <main className={`stage stage--${s.code.toLowerCase()}`}><div className="wrap">
        <div className="stage-head">
          <div className="stage-heading-copy"><span className="stage-title">{s.nm}</span></div>

        </div>
        {body}
      </div></main>
      <div className="foot"><div className="wrap"><div className="foot-in">

        <div style={{ display: 'flex', gap: 12 }}>
          {i > 0 && <button className="btn btn--ghost btn-with-icon" onClick={() => go(-1)}><ArrowLeft size={15} />上一步</button>}
          <button className="btn btn--primary btn-with-icon" style={{ padding: '11px 20px' }} onClick={() => go(1)}>{i === MAX ? <Download size={15} /> : null}{f[1]}{i !== MAX ? <ArrowRight size={15} /> : null}</button>
        </div>
      </div></div></div>
      <div className="colophon"><div className="wrap"><div className="colophon-in">
        <span>他山之石 · AI 广告创作工作台</span>

      </div></div></div>
    </>
  )
}
