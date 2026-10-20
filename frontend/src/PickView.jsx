import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Tile } from './Tile.jsx'
import { api } from './api.js'
import { GRADES, gradeOf } from './grades.js'

const SIZE_MIN = 180
const SIZE_MAX = 600
const SIZE_STEP = 40
// 格子超过缩略图本身的分辨率(320px)就换中等预览,否则放大会糊。
const THUMB_PX = 340
const PREVIEW_PX = 1200
const PREVIEW_PX_HI = 2400   // 放大后格子需要的像素超过 1200 时用
const ZOOM_MIN = 1
const ZOOM_MAX = 4
const ZOOM_STEP = 0.5
const TILE_ASPECT = 4 / 3     // 与 .tile 的 aspect-ratio 一致

const clampSize = (v) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, v))
const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 10) / 10))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// 与对比页同一套锚点:鸟眼 > 鸟框中心 > 画面中心(都是 0-1 归一化坐标)
function anchorFor(s) {
  if (Array.isArray(s.eye_xy) && s.eye_xy.length === 2) return s.eye_xy
  if (Array.isArray(s.bird_bbox) && s.bird_bbox.length === 4) {
    const [x, y, w, h] = s.bird_bbox
    return [x + w / 2, y + h / 2]
  }
  return [0.5, 0.5]
}

// 联动放大:所有格子同一倍数,各自以锚点为中心,再叠加共享的平移(格子宽高的比例)。
// 图片是 object-fit: contain,先算出图在格子里的实际显示区域,再算平移;
// 平移按每张图夹紧,放大后不会露出图外的黑边。纯 CSS transform,200 张也轻。
function zoomStyle(shot, aspect, zoom, pan) {
  if (zoom <= 1) return undefined
  const r = aspect || 1.5
  const [dw, dh] = r >= TILE_ASPECT ? [1, TILE_ASPECT / r] : [r / TILE_ASPECT, 1]
  const ox = (1 - dw) / 2, oy = (1 - dh) / 2
  const [ax, ay] = anchorFor(shot)
  const fit = (anchor, off, span, p) => {
    const t = 0.5 + p - zoom * (off + anchor * span)
    const w = zoom * span
    if (w >= 1) return clamp(t + zoom * off, 1 - w, 0) - zoom * off
    return (1 - w) / 2 - zoom * off
  }
  const tx = fit(ax, ox, dw, pan.x)
  const ty = fit(ay, oy, dh, pan.y)
  return {
    transformOrigin: '0 0',
    transform: `translate(${(tx * 100).toFixed(3)}%, ${(ty * 100).toFixed(3)}%) scale(${zoom})`,
  }
}

// 选片页:网格多选后按 Y 进来,只看这一批;大格子看姿态/构图,打 A/B/C/D 等级。
// 选中状态复用 App 的 selected,所以底栏的精修/保留/移走/对比照常可用。
export function PickView({ shots, selected, setSelected, onOpen, onGrade, rejectedIds, onReject }) {
  const [size, setSize] = useState(() => {
    try { return clampSize(Number(localStorage.getItem('pickTileSize')) || 320) } catch { return 320 }
  })
  useEffect(() => { try { localStorage.setItem('pickTileSize', String(size)) } catch {} }, [size])
  const [gradeFilter, setGradeFilter] = useState('all')   // 'all' | 'none' | 'A'…'D' | 'rejected'
  const [zoom, setZoom] = useState(() => {
    try { return clampZoom(Number(localStorage.getItem('pickZoom')) || 1) } catch { return 1 }
  })
  useEffect(() => { try { localStorage.setItem('pickZoom', String(zoom)) } catch {} }, [zoom])
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [aspects, setAspects] = useState({})   // primary_id → 宽/高,缩略图加载后得到
  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  const sorted = useMemo(() => [...shots].sort((a, b) =>
    (a.shot_at ?? Infinity) - (b.shot_at ?? Infinity) ||
    (a.stem || '').localeCompare(b.stem || '', undefined, { numeric: true })
  ), [shots])

  // 「未选中」的不进全部/等级视图,只在「未选中」里能看到并恢复
  const rejected = useMemo(() => sorted.filter(s => rejectedIds?.has(s.primary_id)), [sorted, rejectedIds])
  const kept = useMemo(() => sorted.filter(s => !rejectedIds?.has(s.primary_id)), [sorted, rejectedIds])

  const counts = useMemo(() => {
    const c = { none: 0 }
    for (const g of GRADES) c[g.key] = 0
    for (const s of kept) { const g = gradeOf(s); c[g ? g.key : 'none']++ }
    return c
  }, [kept])

  // 「未选中」看空了就回到全部
  useEffect(() => { if (gradeFilter === 'rejected' && rejected.length === 0) setGradeFilter('all') }, [gradeFilter, rejected.length])

  const visible = useMemo(() => {
    if (gradeFilter === 'rejected') return rejected
    if (gradeFilter === 'all') return kept
    return kept.filter(s => (gradeOf(s)?.key ?? 'none') === gradeFilter)
  }, [kept, rejected, gradeFilter])

  // 缩放快捷键:- / = 缩小放大格子
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey) return
      if (e.key === '-') { e.preventDefault(); setSize(v => clampSize(v - SIZE_STEP)) }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); setSize(v => clampSize(v + SIZE_STEP)) }
      else if (e.key === '[') { e.preventDefault(); setZoom(v => clampZoom(v - ZOOM_STEP)) }
      else if (e.key === ']') { e.preventDefault(); setZoom(v => clampZoom(v + ZOOM_STEP)) }
      else if (e.key === '\\') { e.preventDefault(); resetZoom() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘/Ctrl + 滚轮(触控板双指捏合也是这个)调放大倍数;普通滚轮照常翻页。
  const gridRef = useRef(null)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom(v => clampZoom(v * Math.exp(-e.deltaY * 0.01)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // 放大后拖任意一格 = 所有格子一起平移;拖动过的那次松手不算点选。
  const dragRef = useRef(null)
  const draggedRef = useRef(false)
  const onPointerDown = (e) => {
    if (zoom <= 1 || e.button !== 0 || e.target.closest('button')) return
    const tile = e.target.closest('.tile')
    if (!tile) return
    const rect = tile.getBoundingClientRect()
    dragRef.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height, pan, moved: false }
    const onMove = (ev) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      const lim = zoom / 2
      setPan({ x: clamp(d.pan.x + dx / d.w, -lim, lim), y: clamp(d.pan.y + dy / d.h, -lim, lim) })
    }
    const onUp = () => {
      draggedRef.current = !!dragRef.current?.moved
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const anchorIdRef = useRef(null)
  const handleTileClick = (id, e) => {
    if (draggedRef.current) { draggedRef.current = false; return }
    if (e?.shiftKey && anchorIdRef.current != null && anchorIdRef.current !== id) {
      const ids = visible.map(s => s.primary_id)
      const a = ids.indexOf(anchorIdRef.current)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(prev => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(ids[i])
          return next
        })
        try { window.getSelection()?.removeAllRanges() } catch {}
        return
      }
    }
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    anchorIdRef.current = id
  }

  const useLarge = size > THUMB_PX || zoom > 1
  const dpr = window.devicePixelRatio || 1
  const previewPx = size * zoom * dpr > PREVIEW_PX ? PREVIEW_PX_HI : PREVIEW_PX

  return (
    <div className="pick-view">
      <div className="grid-sort-bar chips pick-bar">
        <span style={{color:'var(--muted)', fontSize:11}}>选片 {kept.length} 张 · 等级:</span>
        <button className={'chip' + (gradeFilter === 'all' ? ' active' : '')} onClick={() => setGradeFilter('all')}>
          全部 {kept.length}
        </button>
        <button className={'chip' + (gradeFilter === 'none' ? ' active' : '')} onClick={() => setGradeFilter('none')}>
          未评 {counts.none}
        </button>
        {GRADES.map(g => (
          <button
            key={g.key}
            className={'chip' + (gradeFilter === g.key ? ' active' : '')}
            onClick={() => setGradeFilter(g.key)}
            title={g.tag}
          >
            <span className="grade-chip-dot" style={{ background: g.color }}>{g.key}</span>
            {g.label} {counts[g.key]}
          </button>
        ))}
        {rejected.length > 0 && (
          <button
            className={'chip' + (gradeFilter === 'rejected' ? ' active' : '')}
            onClick={() => setGradeFilter('rejected')}
            title="标为未选中的照片:只是不在选片里显示,没有删除,可以恢复"
          >
            未选中 {rejected.length}
          </button>
        )}
        <span className="pick-size" style={{marginLeft:'auto'}} title="联动放大:对准鸟眼(没有则鸟身/中心);⌘+滚轮 或 [ ] 调,放大后可拖动">
          <span style={{color:'var(--muted)', fontSize:11}}>放大</span>
          <input
            type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.1} value={zoom}
            onChange={e => setZoom(clampZoom(Number(e.target.value)))}
            style={{width:110}}
          />
          <span style={{color:'var(--muted)', fontSize:11, minWidth:32, fontVariantNumeric:'tabular-nums'}}>{zoom.toFixed(1)}×</span>
          {(zoom > 1 || pan.x !== 0 || pan.y !== 0) && (
            <button onClick={resetZoom} title="还原 (\)">⟲</button>
          )}
        </span>
        <span className="pick-size" style={{marginLeft:12}}>
          <span style={{color:'var(--muted)', fontSize:11}}>格子</span>
          <button onClick={() => setSize(v => clampSize(v - SIZE_STEP))} title="缩小 (-)">−</button>
          <input
            type="range" min={SIZE_MIN} max={SIZE_MAX} step={20} value={size}
            onChange={e => setSize(clampSize(Number(e.target.value)))}
          />
          <button onClick={() => setSize(v => clampSize(v + SIZE_STEP))} title="放大 (=)">+</button>
          <span style={{color:'var(--muted)', fontSize:11, minWidth:42, fontVariantNumeric:'tabular-nums'}}>{size}px</span>
        </span>
      </div>
      <div style={{fontSize:11, color:'var(--muted)', margin:'0 0 10px'}}>
        单击选 · Shift 范围选 · 双击/Space 看大图 · 1/2/3/4 给选中打 A/B/C/D(再按一次取消)· 0 清除等级 · X 未选中(从选片里藏起来,不删)· −/= 格子大小 · [ ] 或 ⌘+滚轮 联动放大(放大后可拖动)· \ 还原 · Y 回网格
      </div>
      {visible.length === 0 ? (
        <div className="empty">{gradeFilter === 'all' && rejected.length > 0 ? '这批都标成未选中了' : '这个等级下没有照片'}</div>
      ) : (
        <div
          ref={gridRef}
          className={'grid pick-grid' + (zoom > 1 ? ' zoomed' : '')}
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}
          onPointerDown={onPointerDown}
        >
          {visible.map(s => {
            const grade = gradeOf(s)
            const isRejected = rejectedIds?.has(s.primary_id)
            return (
              <Tile
                key={s.primary_id}
                shot={s}
                selected={selected.has(s.primary_id)}
                onToggle={handleTileClick}
                onOpen={(sh) => onOpen(sh, visible)}
                className="pick-tile"
                largeSrc={useLarge ? api.fullUrl(s.primary_id, previewPx) : null}
                imgStyle={zoomStyle(s, aspects[s.primary_id], zoom, pan)}
                onThumbLoad={e => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                  if (w && h) setAspects(prev => prev[s.primary_id] ? prev : { ...prev, [s.primary_id]: w / h })
                }}
              >
                <div className="grade-dots" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                  {GRADES.map(g => {
                    const on = grade?.key === g.key
                    return (
                      <button
                        key={g.key}
                        className={'grade-dot' + (on ? ' on' : '')}
                        style={{ '--grade': g.color }}
                        onClick={() => onGrade([s.primary_id], on ? null : g.key)}
                        title={on ? `${g.tag} · 点击取消` : `标为 ${g.tag}`}
                      >{g.key}</button>
                    )
                  })}
                  <button
                    className="grade-dot reject-dot"
                    style={{ '--grade': isRejected ? '#4fe1c4' : '#8a8f98' }}
                    onClick={() => onReject?.([s.primary_id], !isRejected)}
                    title={isRejected ? '恢复到选片 (X)' : '未选中:从选片里藏起来,不删除 (X)'}
                  >{isRejected ? '↺' : '✕'}</button>
                </div>
              </Tile>
            )
          })}
        </div>
      )}
    </div>
  )
}
