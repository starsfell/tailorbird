import React, { useState, useEffect, useCallback } from 'react'
import { api } from './api.js'
import { PanZoom } from './PanZoom.jsx'

const ZOOM_DEFAULT = 5.0  // 500%
const COMPARE_SOURCE_PX = 6400  // server-resized preview width for compare

// Side-by-side comparison.
//
// Two modes:
//   - linked (default, recommended): each photo is initially zoomed 300% onto
//     its OWN bird eye. When the user pans/zooms ONE photo, the same scale and
//     pan offset is applied to all others while each photo still rotates around
//     its own eye anchor. Pan one => all pan; zoom one => all zoom; eyes stay
//     aligned across the burst.
//   - independent: each photo is fully on its own, useful when the burst has
//     drifted compositionally.
//
// The shared state has three values: { scale, offsetX, offsetY }. Each photo's
// actual transform = (eye_anchor_at_scale + offset). The eye_anchor depends on
// the photo's eye coords and its measured display base size.
export function Compare({ shots, onClose, onDelete }) {
  const [linked, setLinked] = useState(true)
  const [shared, setShared] = useState({ scale: ZOOM_DEFAULT, offsetX: 0, offsetY: 0 })
  const [bases, setBases] = useState({})            // photoId -> {w, h}
  const [indepT, setIndepT] = useState({})          // independent-mode per-shot transforms

  const eyeFor = (s) => s.eye_xy || [0.5, 0.5]

  // Compute each shot's transform in linked mode.
  const linkedTransform = useCallback((s) => {
    const base = bases[s.primary_id]
    if (!base || !base.w) return undefined
    const [ex, ey] = eyeFor(s)
    return {
      scale: shared.scale,
      x: -shared.scale * base.w * (ex - 0.5) + shared.offsetX,
      y: -shared.scale * base.h * (ey - 0.5) + shared.offsetY,
    }
  }, [bases, shared])

  // Reverse-engineer the shared {scale, offsetX, offsetY} from any one photo's
  // newly-reported transform. The eye position + base size let us back out the
  // offset.
  const reportFromShot = useCallback((s, newT) => {
    const base = bases[s.primary_id]
    if (!base) return
    const [ex, ey] = eyeFor(s)
    const eyeAnchorX = -newT.scale * base.w * (ex - 0.5)
    const eyeAnchorY = -newT.scale * base.h * (ey - 0.5)
    setShared({
      scale: newT.scale,
      offsetX: newT.x - eyeAnchorX,
      offsetY: newT.y - eyeAnchorY,
    })
  }, [bases])

  const handleBase = useCallback((s, b) => {
    setBases(prev => ({ ...prev, [s.primary_id]: b }))
  }, [])

  const resetView = () => setShared({ scale: ZOOM_DEFAULT, offsetX: 0, offsetY: 0 })

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 's' || e.key === 'S') setLinked(v => !v)
      else if (e.key === '0') resetView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const n = shots.length
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3

  return (
    <div className="modal">
      <div className="modal-header">
        <div>
          <div style={{fontSize:13}}>
            对比 {n} 张 · {linked ? '联动 (500% 对眼)' : '独立操作'}
          </div>
          <div style={{fontSize:11, color:'var(--muted)', marginTop:2}}>
            S 切换联动 · 0 重置到初始 · Esc 关闭
          </div>
        </div>
        <div style={{display:'flex', gap:8}}>
          <button onClick={resetView}>0 重置</button>
          <button onClick={() => setLinked(v => !v)}>{linked ? '解除联动' : '开启联动'}</button>
          <button onClick={onClose}>Esc 关闭</button>
        </div>
      </div>
      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {shots.map(s => {
          const eye = s.eye_sharpness == null ? null : s.eye_sharpness.toFixed(2)
          const subj = s.subject_sharpness == null ? '—' : s.subject_sharpness.toFixed(2)
          const stars = '★'.repeat(s.rating ?? 0) + '☆'.repeat(3 - (s.rating ?? 0))
          const ownFocus = {
            x: eyeFor(s)[0], y: eyeFor(s)[1], scale: ZOOM_DEFAULT,
          }
          return (
            <div key={s.primary_id} className="compare-cell">
              <div className="compare-cell-head">
                <span style={{display:'flex', alignItems:'center', gap:4}}>
                  <span style={{color:'#ffd866'}}>{stars}</span>
                  <span>{s.stem}</span>
                  {s.pick && <span className="badge pick-flag">P</span>}
                  {s.focus_weight != null && s.focus_weight >= 1.05 && <span className="badge focus-best">精焦</span>}
                </span>
                <span style={{color:'var(--muted)', fontVariantNumeric:'tabular-nums'}}>
                  {eye ? `眼${eye}` : `主${subj}`}
                </span>
                <button onClick={() => onDelete?.(s)} className="danger" style={{padding:'2px 8px'}}>删</button>
              </div>
              <PanZoom
                src={api.fullUrl(s.primary_id, COMPARE_SOURCE_PX)}
                onBaseChange={(b) => handleBase(s, b)}
                transform={linked ? linkedTransform(s) : (indepT[s.primary_id] || undefined)}
                onTransform={(nt) =>
                  linked
                    ? reportFromShot(s, nt)
                    : setIndepT(prev => ({ ...prev, [s.primary_id]: nt }))
                }
                initialFocus={!linked ? ownFocus : undefined}
              />
            </div>
          )
        })}
      </div>
      <div className="modal-hint">
        联动模式: 拖任意一张,所有图同步平移;滚轮缩放,每张围绕自己的眼睛缩放,鸟眼始终对齐
      </div>
    </div>
  )
}
