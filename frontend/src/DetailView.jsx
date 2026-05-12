import React, { useEffect, useState } from 'react'
import { api } from './api.js'
import { PanZoom } from './PanZoom.jsx'

function Stars({ n }) {
  if (n == null || n < 0) return <span style={{color:'var(--muted)'}}>无鸟</span>
  return <span style={{color:'#ffd866'}}>{'★'.repeat(n)}{'☆'.repeat(3 - n)}</span>
}

// Overlays for existing (AI) bbox/eye/AF point.
function Overlays({ detail, manual, showAf, showBbox, showEye }) {
  if (!detail) return null
  const items = []
  if (showBbox && detail.bird_bbox) {
    const [x, y, w, h] = detail.bird_bbox
    items.push(<div key="bbox" className="overlay-bbox" style={{
      left:`${x*100}%`, top:`${y*100}%`, width:`${w*100}%`, height:`${h*100}%`,
    }} />)
  }
  if (showAf && detail.focus_point && detail.width && detail.height) {
    const fp = detail.focus_point
    const iw = fp.image_w || detail.width, ih = fp.image_h || detail.height
    const cx = fp.x / iw, cy = fp.y / ih
    const fw = (fp.w || 100) / iw, fh = (fp.h || 100) / ih
    items.push(<div key="af" className="overlay-af" style={{
      left:`${(cx-fw/2)*100}%`, top:`${(cy-fh/2)*100}%`,
      width:`${fw*100}%`, height:`${fh*100}%`,
    }} />)
  }
  if (showEye && detail.eye_xy) {
    const [ex, ey] = detail.eye_xy
    items.push(<div key="eye" className="overlay-eye" style={{
      left:`${ex*100}%`, top:`${ey*100}%`,
    }} />)
  }
  if (manual?.bbox) {
    const { x, y, w, h } = manual.bbox
    items.push(<div key="mb" className="overlay-manual-bbox" style={{
      position:'absolute', pointerEvents:'none',
      left:`${x*100}%`, top:`${y*100}%`, width:`${w*100}%`, height:`${h*100}%`,
    }} />)
  }
  if (manual?.eye) {
    const { x, y } = manual.eye
    items.push(<div key="me" className="overlay-manual-eye" style={{
      position:'absolute', pointerEvents:'none',
      left:`${x*100}%`, top:`${y*100}%`,
    }} />)
  }
  return <>{items}</>
}

export function DetailView({ shots, startIndex = 0, onClose, onDelete, onRefresh }) {
  const [idx, setIdx] = useState(startIndex)
  const [detail, setDetail] = useState(null)
  const [showAf, setShowAf] = useState(true)
  const [showBbox, setShowBbox] = useState(true)
  const [showEye, setShowEye] = useState(true)

  // Annotation state: 'rect' → drag for bird box, 'point' → click for eye, null = off
  const [annotMode, setAnnotMode] = useState(null)
  const [manual, setManual] = useState({ bbox: null, eye: null })
  useEffect(() => { setIdx(startIndex) }, [startIndex])

  const shot = shots[idx]

  useEffect(() => {
    if (!shot) return
    setDetail(null)
    setAnnotMode(null)
    setManual({ bbox: null, eye: null })
    api.photoDetail(shot.primary_id).then(setDetail).catch(() => setDetail(null))
  }, [shot])

  useEffect(() => {
    const onKey = (e) => {
      if (annotMode) {
        if (e.key === 'Escape') { setAnnotMode(null); setManual({ bbox: null, eye: null }) }
        return
      }
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J')
        setIdx(i => Math.min(shots.length - 1, i + 1))
      else if (e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K')
        setIdx(i => Math.max(0, i - 1))
      else if (e.key === 'd' || e.key === 'D') { if (shot) onDelete?.(shot) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shots, shot, onClose, onDelete, annotMode])

  const startAnnotate = () => {
    setAnnotMode('rect')
    setManual({ bbox: null, eye: null })
  }
  const cancelAnnotate = () => {
    setAnnotMode(null)
    setManual({ bbox: null, eye: null })
  }
  const onRect = (r) => {
    setManual(prev => ({ ...prev, bbox: r }))
    setAnnotMode('point')
  }
  const onPoint = (p) => {
    setManual(prev => ({ ...prev, eye: p }))
  }
  const saveAnnot = async () => {
    if (!manual.bbox || !shot) return
    try {
      await api.annotate(
        shot.primary_id,
        [manual.bbox.x, manual.bbox.y, manual.bbox.w, manual.bbox.h],
        manual.eye ? [manual.eye.x, manual.eye.y] : null,
      )
      // Re-fetch this photo's detail and signal parent to refresh shot list
      const fresh = await api.photoDetail(shot.primary_id)
      setDetail(fresh)
      setAnnotMode(null)
      setManual({ bbox: null, eye: null })
      onRefresh?.()
    } catch (e) {
      alert('标注保存失败: ' + e.message)
    }
  }

  if (!shot) return null
  const sharp = shot.subject_sharpness == null ? '—' : shot.subject_sharpness.toFixed(4)
  const eye = shot.eye_sharpness == null ? null : shot.eye_sharpness.toFixed(2)
  const aes = shot.aesthetic_score == null ? null : shot.aesthetic_score.toFixed(2)

  return (
    <div className="modal">
      <div className="modal-header">
        <div>
          <div style={{fontSize:13, display:'flex', alignItems:'center', gap:8}}>
            <Stars n={shot.rating} />
            <span>{shot.stem} · {shot.formats.join('+')}</span>
            {shot.pick && <span className="badge pick-flag">PICK</span>}
            {shot.is_flying && <span className="badge flying">飞</span>}
            {shot.is_cluster_best && <span style={{color:'var(--accent)'}}>★组内最佳</span>}
          </div>
          <div style={{fontSize:11, color:'var(--muted)', marginTop:2}}>
            主体锐度 {sharp}
            {eye && <> · 眼部锐度 {eye}</>}
            {aes && <> · 美学 {aes}</>}
            {shot.bird_confidence != null && <> · 鸟检测 {Math.round(shot.bird_confidence * 100)}%</>}
            {shot.focus_weight != null && <> · 焦点权重 {shot.focus_weight.toFixed(2)}</>}
            {' · '}{idx + 1}/{shots.length}
          </div>
        </div>
        {!annotMode && (
          <>
            <div style={{display:'flex', gap:6, fontSize:11, alignItems:'center'}}>
              <label><input type="checkbox" checked={showBbox} onChange={e=>setShowBbox(e.target.checked)} /> 鸟框</label>
              <label><input type="checkbox" checked={showEye} onChange={e=>setShowEye(e.target.checked)} /> 眼睛</label>
              <label><input type="checkbox" checked={showAf} onChange={e=>setShowAf(e.target.checked)} /> AF</label>
            </div>
            <div style={{display:'flex', gap:8}}>
              <button onClick={startAnnotate} title="手动标注鸟框和眼位">手动标注</button>
              <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}>← K</button>
              <button onClick={() => setIdx(i => Math.min(shots.length - 1, i + 1))} disabled={idx >= shots.length - 1}>J →</button>
              <button className="danger" onClick={() => onDelete?.(shot)}>D 删除</button>
              <button onClick={onClose}>Esc 关闭</button>
            </div>
          </>
        )}
        {annotMode && (
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <span style={{fontSize:12, color:'#ffd866'}}>
              {annotMode === 'rect' && '1. 拖动鼠标框选鸟主体'}
              {annotMode === 'point' && (manual.eye ? '完成 — 可重新点击眼睛或保存' : '2. 点击鸟眼位置(可跳过)')}
            </span>
            <button onClick={saveAnnot} disabled={!manual.bbox} className="primary">保存</button>
            <button onClick={cancelAnnotate}>取消</button>
          </div>
        )}
      </div>
      <PanZoom
        src={api.fullUrl(shot.primary_id)}
        annotateMode={annotMode}
        onAnnotateRect={onRect}
        onAnnotateClick={onPoint}
      >
        <Overlays detail={detail} manual={manual} showAf={showAf && !annotMode} showBbox={showBbox} showEye={showEye} />
      </PanZoom>
      <div className="modal-hint">
        {annotMode
          ? '标注模式 · 黄虚线 = 正在画的鸟框 · 黄实线 = 已保存的框 · 黄点 = 眼位 · Esc 取消'
          : '滚轮缩放 · 拖动平移 · 双击 100%/适应 · J/K 翻图 · 红框=相机 AF · 绿框=AI 鸟检测 · 黄点=AI 眼位'}
      </div>
    </div>
  )
}
