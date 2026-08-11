import { useEffect, useRef, useState } from 'react'
import { useStore, useToast, STEPS } from '../store'

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { dispatch } = useStore()
  const toast = useToast()
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 40) } }, [open])
  if (!open) return null

  const go = (step: number) => dispatch({ type: 'goStep', step })
  const items = [
    ...STEPS.map((s, i) => ({ t: `跳转 · ${s.no} ${s.nm}`, k: s.code, act: () => go(i) })),
    { t: '操作 · 另存为套路 skill', k: 'SAVE', act: () => toast('另存为套路 skill') },
    { t: '操作 · 导出成片', k: 'EXPORT', act: () => toast('导出中') },
  ]
  const filtered = items.filter(p => p.t.toLowerCase().includes(q.toLowerCase()) || p.k.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="palette" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pal-box">
        <input ref={inputRef} className="pal-input" placeholder="跳转环节 / 执行操作…" value={q} onChange={e => setQ(e.target.value)} />
        <div>
          {filtered.map((p, i) => (
            <div key={p.t} className={`pal-row ${i === 0 ? 'on' : ''}`} onClick={() => { onClose(); p.act() }}>
              <span>{p.t}</span><span className="kbd">{p.k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
