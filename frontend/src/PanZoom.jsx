import React, { useEffect, useRef, useState, useCallback } from 'react'

// A pannable, zoomable single image viewport with overlay + annotation support.
//
// Props:
//   src             image URL
//   transform       optional controlled {scale, x, y}
//   onTransform     callback when transform changes (always called)
//   initialFocus    optional {x, y, scale} applied once on first base measurement
//   onBaseChange    callback with {w, h} = image's display size at scale=1
//   annotateMode    "rect" | "point" | null
//                     - rect: drag to draw rectangle, mouseup emits onAnnotateRect
//                     - point: single click emits onAnnotateClick
//                     - null (default): normal pan/zoom
//   onAnnotateRect  ({x, y, w, h}) normalized within the displayed image
//   onAnnotateClick ({x, y}) normalized within the displayed image
//   children        overlays positioned by normalized %s (move with transform)
export function PanZoom({
  src, transform, onTransform, children,
  initialFocus, onBaseChange,
  annotateMode = null, onAnnotateRect, onAnnotateClick,
}) {
  const wrapRef = useRef(null)
  const stageRef = useRef(null)
  const imgRef = useRef(null)
  const [internal, setInternal] = useState({ scale: 1, x: 0, y: 0 })
  const t = transform || internal
  const setT = useCallback((nt) => {
    if (typeof nt === 'function') nt = nt(t)
    if (onTransform) onTransform(nt)
    else setInternal(nt)
  }, [t, onTransform])

  const dragRef = useRef(null)
  const annotateRef = useRef(null)
  const [draftRect, setDraftRect] = useState(null)
  const [base, setBase] = useState({ w: 0, h: 0 })
  const initAppliedRef = useRef(false)

  const recalcBase = useCallback(() => {
    const wrap = wrapRef.current
    const img = imgRef.current
    if (!wrap || !img || !img.naturalWidth) return
    const cw = wrap.clientWidth
    const ch = wrap.clientHeight
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    const scale = Math.min(cw / iw, ch / ih)
    const newBase = { w: Math.round(iw * scale), h: Math.round(ih * scale) }
    setBase(newBase)
    if (onBaseChange) onBaseChange(newBase)

    if (!initAppliedRef.current && initialFocus && newBase.w > 0) {
      const cur = transform || internal
      const atIdentity =
        Math.abs((cur.scale ?? 1) - 1) < 0.001 &&
        (cur.x ?? 0) === 0 && (cur.y ?? 0) === 0
      if (atIdentity) {
        initAppliedRef.current = true
        const { x = 0.5, y = 0.5, scale: s = 3 } = initialFocus
        setT({
          scale: s,
          x: -s * newBase.w * (x - 0.5),
          y: -s * newBase.h * (y - 0.5),
        })
      } else {
        initAppliedRef.current = true
      }
    }
  }, [initialFocus, setT, transform, internal, onBaseChange])

  useEffect(() => { initAppliedRef.current = false }, [src])

  useEffect(() => {
    recalcBase()
    const ro = new ResizeObserver(recalcBase)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [recalcBase, src])

  // --- normal pan/zoom handlers ---
  // 放大/缩小到指定屏幕坐标 (clientX, clientY)
  const zoomAt = useCallback((clientX, clientY, k) => {
    const rect = wrapRef.current.getBoundingClientRect()
    const cx = clientX - rect.left - rect.width / 2
    const cy = clientY - rect.top - rect.height / 2
    setT(prev => {
      const ns = Math.min(20, Math.max(0.2, prev.scale * k))
      const ratio = ns / prev.scale
      return {
        scale: ns,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }
    })
  }, [setT])

  const onWheel = (e) => {
    if (annotateMode) return
    e.preventDefault()
    // Mac 触摸板 pinch 在 Chrome/Edge 下以 wheel + ctrlKey 形式出现，deltaY 通常 <10；
    // 普通鼠标滚轮 deltaY 是 ~100 量级；触摸板二指滚动 deltaY 中等，无 ctrlKey。
    // 三档系数避免 pinch 被普通滚轮的系数压得几乎不动。
    const isPinch = e.ctrlKey
    const absDy = Math.abs(e.deltaY)
    let factor
    if (isPinch) factor = 0.20            // Chrome trackpad pinch（deltaY 常 <2）
    else if (absDy < 50) factor = 0.015   // 触摸板二指滑动
    else factor = 0.0035                   // 鼠标滚轮
    const k = Math.exp(-e.deltaY * factor)
    zoomAt(e.clientX, e.clientY, k)
  }

  // Safari pinch 走 gesture 事件而不是 wheel；e.scale 是累计缩放因子。
  const gestureRef = useRef(null)
  const onGestureStart = (e) => {
    if (annotateMode) return
    e.preventDefault()
    gestureRef.current = { lastScale: e.scale || 1, x: e.clientX, y: e.clientY }
  }
  const onGestureChange = (e) => {
    if (annotateMode || !gestureRef.current) return
    e.preventDefault()
    const g = gestureRef.current
    const cur = e.scale || 1
    const k = cur / g.lastScale
    g.lastScale = cur
    zoomAt(e.clientX || g.x, e.clientY || g.y, k)
  }
  const onGestureEnd = (e) => {
    if (annotateMode) return
    e.preventDefault()
    gestureRef.current = null
  }

  // --- annotation handlers ---
  const normalizeAt = (clientX, clientY) => {
    const r = stageRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return null
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
    }
  }

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    if (annotateMode === 'rect') {
      const p = normalizeAt(e.clientX, e.clientY)
      if (!p) return
      annotateRef.current = { sx: p.x, sy: p.y, mx: e.clientX, my: e.clientY }
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 })
    } else if (annotateMode === 'point') {
      // wait for click on mouseup; nothing on mousedown
    } else {
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y }
    }
  }
  const onMouseMove = (e) => {
    if (annotateMode === 'rect' && annotateRef.current) {
      const p = normalizeAt(e.clientX, e.clientY)
      if (!p) return
      const { sx, sy } = annotateRef.current
      setDraftRect({
        x: Math.min(sx, p.x), y: Math.min(sy, p.y),
        w: Math.abs(p.x - sx), h: Math.abs(p.y - sy),
      })
    } else if (!annotateMode && dragRef.current) {
      const d = dragRef.current
      setT(prev => ({ ...prev, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }))
    }
  }
  const onMouseUp = (e) => {
    if (annotateMode === 'rect' && annotateRef.current) {
      const rect = draftRect
      annotateRef.current = null
      setDraftRect(null)
      if (rect && rect.w > 0.005 && rect.h > 0.005 && onAnnotateRect) {
        onAnnotateRect(rect)
      }
    } else if (annotateMode === 'point') {
      const p = normalizeAt(e.clientX, e.clientY)
      if (p && onAnnotateClick) onAnnotateClick(p)
    } else {
      dragRef.current = null
    }
  }

  const reset = () => setT({ scale: 1, x: 0, y: 0 })
  const fitOneToOne = () => {
    const img = imgRef.current
    if (!img || !base.w) { setT({ scale: 2.5, x: 0, y: 0 }); return }
    setT({ scale: img.naturalWidth / base.w, x: 0, y: 0 })
  }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart, { passive: false })
    el.addEventListener('gesturechange', onGestureChange, { passive: false })
    el.addEventListener('gestureend', onGestureEnd, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
      el.removeEventListener('gestureend', onGestureEnd)
    }
    // eslint-disable-next-line
  }, [t, annotateMode])

  const cursor = annotateMode ? 'crosshair' : (dragRef.current ? 'grabbing' : 'grab')

  return (
    <div
      className="panzoom"
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={annotateMode ? undefined : (() => (t.scale > 1.2 ? reset() : fitOneToOne()))}
      style={{ cursor }}
    >
      <div
        className="panzoom-stage"
        ref={stageRef}
        style={{
          width: base.w || 'auto',
          height: base.h || 'auto',
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transformOrigin: 'center center',
          position: 'relative',
        }}
      >
        <img
          ref={imgRef}
          src={src}
          draggable={false}
          onLoad={recalcBase}
          style={{ width: '100%', height: '100%', display: 'block', userSelect: 'none' }}
        />
        {children}
        {draftRect && (
          <div className="annotate-draft" style={{
            position: 'absolute', pointerEvents: 'none',
            left: `${draftRect.x * 100}%`, top: `${draftRect.y * 100}%`,
            width: `${draftRect.w * 100}%`, height: `${draftRect.h * 100}%`,
          }} />
        )}
      </div>
    </div>
  )
}
