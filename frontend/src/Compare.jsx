import React, { useState, useEffect, useCallback } from 'react'
import { api } from './api.js'
import { PanZoom } from './PanZoom.jsx'

const ZOOM_DEFAULT = 5.0  // 500%
const COMPARE_SOURCE_PX = 6400

// Side-by-side comparison with linked pan/zoom by default.
//
// All photos use a single shared {scale, offsetX, offsetY}. Each photo's
// transform = -scale * base * (anchor - 0.5) + offset, where `anchor` is the
// photo's logical center-of-interest:
//   - eye_xy (AI eye keypoint) if detected
//   - bird_bbox center if a bird was detected but no eye
//   - image center (0.5, 0.5) otherwise
// This means every bird's interest point sits at the same screen position; pan
// or zoom any photo and all others follow.
//
// S (or the button) disables linkage entirely; in that mode each photo is on
// its own (still fit-to-cell initially).
export function Compare({ shots, onClose, onDelete }) {
  const [linked, setLinked] = useState(true)
  const [shared, setShared] = useState({ scale: ZOOM_DEFAULT, offsetX: 0, offsetY: 0 })
  const [bases, setBases] = useState({})
  const [indepT, setIndepT] = useState({})

  const anchorFor = (s) => {
    if (Array.isArray(s.eye_xy) && s.eye_xy.length === 2) return s.eye_xy
    if (Array.isArray(s.bird_bbox) && s.bird_bbox.length === 4) {
      const [x, y, w, h] = s.bird_bbox
      return [x + w / 2, y + h / 2]
    }
    return [0.5, 0.5]
  }

  const transformForShot = useCallback((s) => {
    const base = bases[s.primary_id]
    if (!base || !base.w) return undefined
    if (!linked) {
      return indepT[s.primary_id] || { scale: 1, x: 0, y: 0 }
    }
    const [ax, ay] = anchorFor(s)
    return {
      scale: shared.scale,
      x: -shared.scale * base.w * (ax - 0.5) + shared.offsetX,
      y: -shared.scale * base.h * (ay - 0.5) + shared.offsetY,
    }
  }, [bases, shared, linked, indepT])

  const reportFromShot = useCallback((s, newT) => {
    if (!linked) {
      setIndepT(prev => ({ ...prev, [s.primary_id]: newT }))
      return
    }
    const base = bases[s.primary_id]
    if (!base) return
    const [ax, ay] = anchorFor(s)
    const anchorX = -newT.scale * base.w * (ax - 0.5)
    const anchorY = -newT.scale * base.h * (ay - 0.5)
    setShared({
      scale: newT.scale,
      offsetX: newT.x - anchorX,
      offsetY: newT.y - anchorY,
    })
  }, [bases, linked])

  const handleBase = useCallback((s, b) => {
    setBases(prev => ({ ...prev, [s.primary_id]: b }))
  }, [])

  const resetView = () => {
    setShared({ scale: ZOOM_DEFAULT, offsetX: 0, offsetY: 0 })
    setIndepT({})
  }

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
            对比 {n} 张 · {linked ? '联动 (500% 对鸟眼/鸟身/中心)' : '独立操作'}
          </div>
          <div style={{fontSize:11, color:'var(--muted)', marginTop:2}}>
            S 切换联动 · 0 重置 · Esc 关闭
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
          const stars = s.rating == null || s.rating < 0
            ? '— 无鸟 —'
            : ('★'.repeat(s.rating) + '☆'.repeat(3 - s.rating))
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
                transform={transformForShot(s)}
                onTransform={(nt) => reportFromShot(s, nt)}
              />
            </div>
          )
        })}
      </div>
      <div className="modal-hint">
        联动模式: 所有图共享缩放和平移,以各自的鸟眼/鸟身/图心为锚点;拖一张所有图跟着动
      </div>
    </div>
  )
}
