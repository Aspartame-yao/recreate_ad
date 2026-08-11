import type { AppState } from '../types'

export function navigationBlockReason(state: AppState, target: number): string | null {
  if (target <= state.step) return null
  if (target <= 1) return null
  if (!state.shots.length) return '请先在 1.0 完成整片反推，并在 2.0 完成视频复刻'
  const missing = state.shots.filter(sh => sh.status !== 'done' || !sh.videoUrl)
  if (missing.length) return `请先在 2.0 完成全部复刻视频（还差 ${missing.length} 段）`
  return null
}
