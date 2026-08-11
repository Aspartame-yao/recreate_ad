import { useStore, STEPS } from '../store'
import { Captions, Clapperboard, Film, Image, ScanSearch } from 'lucide-react'

export function Rail() {
  const { state, dispatch } = useStore()
  const go = (step: number) => dispatch({ type: 'goStep', step })
  const icons = [ScanSearch, Clapperboard, Captions, Film, Image]
  const descriptions = ['拆解爆款结构', '生成同款镜头', '清理画面素材', '编排完整成片', '包装发布物料']
  return (
    <div className="rail"><div className="rail-in">
      {STEPS.map((x, i) => {
        const st = i < state.step ? 'done' : i === state.step ? 'active' : ''
        const Icon = icons[i]
        return (
          <button key={x.no} type="button" title={`${x.no} ${x.nm}`} aria-label={`${x.no} ${x.nm}`} className={`rail-step ${st}`} onClick={() => go(i)}>
            <span className="rail-icon"><Icon size={17} strokeWidth={1.8} /></span>
            <span className="rail-copy"><span className="nm">{x.nm}</span><small>{descriptions[i]}</small></span>
          </button>
        )
      })}
    </div></div>
  )
}
