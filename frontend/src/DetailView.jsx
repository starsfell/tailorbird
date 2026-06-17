import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { PanZoom } from './PanZoom.jsx'
import { buildTagTree, tagPath } from './tagTree.js'

function TagBar({ primaryId, tags, setTags, allTags, onTagsRefresh }) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef(null)

  const attached = tags || []
  const attachedIds = new Set(attached.map(t => t.id))
  const { byId } = useMemo(() => buildTagTree(allTags), [allTags])
  const pathOf = (id) => tagPath(byId, id).join(' / ')

  const favorites = allTags.filter(t => t.is_favorite && !attachedIds.has(t.id))

  const q = text.trim()
  const qLower = q.toLowerCase()
  // Match against full path so user can type either "白鹭" or "鸟类/水鸟" to find leaves.
  const matches = q
    ? allTags
        .filter(t => !attachedIds.has(t.id))
        .map(t => ({ tag: t, path: pathOf(t.id) }))
        .filter(({ path }) => path.toLowerCase().includes(qLower))
        .slice(0, 10)
    : []
  const exactExists = q && allTags.some(t => pathOf(t.id).toLowerCase() === qLower)

  const addExisting = async (tag) => {
    await api.batchPhotoTags([primaryId], { add_tag_ids: [tag.id] })
    setText('')
    setTags([...attached, { id: tag.id, name: tag.name, color: tag.color }])
  }
  const addNew = async (rawName) => {
    const trimmed = rawName.trim()
    if (!trimmed) return
    await api.batchPhotoTags([primaryId], { add_tag_names: [trimmed] })
    setText('')
    // Refresh global tag list to learn the leaf id (for slash paths, only the leaf gets attached).
    const fresh = await api.listTags()
    onTagsRefresh?.(fresh.tags)
    const leafName = trimmed.split('/').pop().trim().toLowerCase()
    const created = fresh.tags.find(t => t.name.toLowerCase() === leafName)
    if (created && !attachedIds.has(created.id)) {
      setTags([...attached, { id: created.id, name: created.name, color: created.color }])
    }
  }
  const remove = async (tagId) => {
    await api.batchPhotoTags([primaryId], { remove_tag_ids: [tagId] })
    setTags(attached.filter(t => t.id !== tagId))
  }
  const toggleFavorite = async (tag) => {
    await api.updateTag(tag.id, { is_favorite: !tag.is_favorite })
    const fresh = await api.listTags()
    onTagsRefresh?.(fresh.tags)
  }

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!q) return
      // Path match wins; otherwise fall back to leaf-name match; otherwise create.
      const byPath = allTags.find(t => pathOf(t.id).toLowerCase() === qLower)
      if (byPath) {
        if (!attachedIds.has(byPath.id)) addExisting(byPath)
        return
      }
      const byLeaf = !q.includes('/')
        ? allTags.find(t => t.name.toLowerCase() === qLower)
        : null
      if (byLeaf) {
        if (!attachedIds.has(byLeaf.id)) addExisting(byLeaf)
      } else {
        addNew(q)
      }
    } else if (e.key === 'Escape') {
      setText(''); setFocused(false); inputRef.current?.blur()
    }
  }

  const findInAll = (id) => allTags.find(t => t.id === id)

  return (
    <div className="tag-bar" onMouseDown={(e) => e.stopPropagation()}>
      <span className="group-label">标签</span>
      {attached.map(t => {
        const full = findInAll(t.id)
        const fav = full?.is_favorite
        const path = pathOf(t.id)
        const isNested = path.includes(' / ')
        return (
          <span key={t.id} className="tag-chip applied" title={isNested ? path : t.name}>
            <span>{t.name}</span>
            {full && (
              <span className={'star' + (fav ? ' on' : '')} title={fav ? '取消常用' : '设为常用'}
                onClick={() => toggleFavorite(full)}>★</span>
            )}
            <span className="x" title="移除" onClick={() => remove(t.id)}>×</span>
          </span>
        )
      })}
      {favorites.length > 0 && (
        <>
          <span className="group-label" style={{marginLeft:8}}>常用</span>
          {favorites.map(t => (
            <span key={t.id} className="tag-chip quick" title={pathOf(t.id) || '一键添加'}
              onClick={() => addExisting(t)}>+ {t.name}</span>
          ))}
        </>
      )}
      <span className="tag-input-wrap">
        <input
          ref={inputRef}
          type="text"
          placeholder="+ 加标签 (支持 父/子/孙)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {focused && q && (
          <div className="tag-suggest">
            {matches.map(({ tag, path }) => (
              <div key={tag.id} className="item" onClick={() => addExisting(tag)}>
                <span>{path}</span>
                <span className="count">{tag.usage_count}</span>
              </div>
            ))}
            {!exactExists && (
              <div className="item create" onClick={() => addNew(q)}>
                + 创建 "{q}"{q.includes('/') ? '(路径)' : ''}
              </div>
            )}
            {matches.length === 0 && exactExists && (
              <div className="item" style={{color:'var(--muted)'}}>已存在且已添加</div>
            )}
          </div>
        )}
      </span>
    </div>
  )
}

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

  // Tags: keep a local override per-shot so mutations are instant.
  const [allTags, setAllTags] = useState([])
  const [localTags, setLocalTags] = useState(null)
  useEffect(() => {
    api.listTags().then(r => setAllTags(r.tags || [])).catch(() => {})
  }, [])
  useEffect(() => { setIdx(startIndex) }, [startIndex])

  const shot = shots[idx]
  const shotTags = localTags !== null ? localTags : (shot?.tags || [])

  useEffect(() => {
    if (!shot) return
    setDetail(null)
    setAnnotMode(null)
    setManual({ bbox: null, eye: null })
    setLocalTags(null)  // re-sync to shot.tags when navigating
    api.photoDetail(shot.primary_id).then(setDetail).catch(() => setDetail(null))
  }, [shot])

  useEffect(() => {
    const onKey = (e) => {
      // Don't intercept while typing in the tag input.
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (annotMode) {
        if (e.key === 'Escape') { setAnnotMode(null); setManual({ bbox: null, eye: null }) }
        return
      }
      // 左手键(D/R/←→)与右手键(J/U/;/L)双套并行。右手 J=删除,故翻页用 ;(下)/L(上)。
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') onClose()
      else if (k === 'd' || k === 'j') { if (shot) onDelete?.(shot) }   // 删除
      else if (e.key === 'ArrowRight' || e.key === ';')   // 下一张
        setIdx(i => Math.min(shots.length - 1, i + 1))
      else if (e.key === 'ArrowLeft' || k === 'k' || k === 'l')   // 上一张
        setIdx(i => Math.max(0, i - 1))
      else if (k === 'r' || k === 'u') {   // Finder
        if (shot) {
          e.preventDefault()
          api.revealInFinder(shot.primary_id).catch(err => alert('打开 Finder 失败: ' + err.message))
        }
      }
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
              <button onClick={() => api.revealInFinder(shot.primary_id).catch(e => alert(e.message))}
                title="在 Finder 中显示这张照片 (R / U)">📁 Finder</button>
              <button onClick={startAnnotate} title="手动标注鸟框和眼位">手动标注</button>
              <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0} title="上一张 (← / K / L)">← 上一张</button>
              <button onClick={() => setIdx(i => Math.min(shots.length - 1, i + 1))} disabled={idx >= shots.length - 1} title="下一张 (→ / ;)">下一张 →</button>
              <button className="danger" onClick={() => onDelete?.(shot)} title="删除 (D / J)">删除</button>
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
      <TagBar
        primaryId={shot.primary_id}
        tags={shotTags}
        setTags={(t) => { setLocalTags(t); onRefresh?.() }}
        allTags={allTags}
        onTagsRefresh={(tags) => setAllTags(tags)}
      />
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
