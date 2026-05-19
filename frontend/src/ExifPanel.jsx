import React, { useEffect, useState } from 'react'
import { api } from './api.js'

// Right-side panel showing EXIF / shooting params for the currently focused
// photo. Sits above TagFilterPanel in the right column.
//
// Source of "focused" photo, in priority order:
//   1. props.detailShot (when DetailView is open — that's the active photo)
//   2. exactly-one selection from the grid
//
// When multiple shots are selected, show a multi-shot summary (count + ISO
// range + lens distribution). When nothing's selected, show a hint.

function fmtShutter(t) {
  if (t == null) return '—'
  if (t >= 1) return `${t}s`
  const denom = Math.round(1 / t)
  return `1/${denom}s`
}
function fmtFNumber(f) { return f == null ? '—' : `f/${f.toFixed(1)}` }
function fmtFocal(mm) { return mm == null ? '—' : `${Math.round(mm)}mm` }
function fmtIso(i) { return i == null ? '—' : `ISO ${i}` }
function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString('zh-CN', { hour12: false })
}

function Row({ label, value, mono }) {
  return (
    <div className="exif-row">
      <span className="lab">{label}</span>
      <span className="val" style={mono ? { fontFamily: 'ui-monospace, monospace' } : undefined}>{value}</span>
    </div>
  )
}

export function ExifPanel({ expanded, setExpanded, focusedShot, selectedShots }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const single = focusedShot ?? (selectedShots?.length === 1 ? selectedShots[0] : null)
  const multi = !single && selectedShots && selectedShots.length > 1 ? selectedShots : null

  useEffect(() => {
    if (!single || typeof single.primary_id !== 'number') {
      setDetail(null); return
    }
    let alive = true
    setLoading(true)
    api.photoDetail(single.primary_id)
      .then(d => { if (alive) setDetail(d) })
      .catch(() => { if (alive) setDetail(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [single?.primary_id])

  if (!expanded) {
    return (
      <aside className="exif-panel collapsed">
        <button className="panel-toggle" onClick={() => setExpanded(true)} title="展开拍摄信息">
          <span>EXIF</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="exif-panel expanded">
      <div className="panel-head">
        <h3>拍摄信息</h3>
        <button onClick={() => setExpanded(false)} title="收起">›</button>
      </div>
      <div className="panel-body exif-body">
        {!single && !multi && (
          <div className="exif-empty">
            选中 1 张照片看拍摄参数<br/>
            <span style={{color:'var(--muted)', fontSize:11}}>多选时会显示汇总</span>
          </div>
        )}

        {single && (
          <div>
            <div className="exif-section">
              <Row label="ISO" value={loading && !detail ? '…' : fmtIso(detail?.iso)} mono />
              <Row label="快门" value={loading && !detail ? '…' : fmtShutter(detail?.exposure_time)} mono />
              <Row label="光圈" value={loading && !detail ? '…' : fmtFNumber(detail?.f_number)} mono />
              <Row label="焦距" value={loading && !detail ? '…' : fmtFocal(detail?.focal_length)} mono />
            </div>
            <div className="exif-section">
              <Row label="镜头" value={detail?.lens_model ?? '—'} />
              <Row label="机型" value={detail?.camera_model ?? '—'} />
            </div>
            <div className="exif-section">
              <Row label="拍摄时间" value={fmtTime(detail?.shot_at)} mono />
              <Row label="尺寸" value={detail?.width && detail?.height ? `${detail.width} × ${detail.height}` : '—'} mono />
              <Row label="文件" value={single.stem} mono />
            </div>
            <div className="exif-section">
              <Row label="主体锐度" value={detail?.subject_sharpness != null ? detail.subject_sharpness.toFixed(2) : '—'} mono />
              <Row label="鸟眼锐度" value={detail?.eye_sharpness != null ? detail.eye_sharpness.toFixed(2) : '—'} mono />
              <Row label="美学" value={detail?.aesthetic_score != null ? detail.aesthetic_score.toFixed(2) : '—'} mono />
              <Row label="鸟检置信" value={detail?.bird_confidence != null ? `${(detail.bird_confidence * 100).toFixed(0)}%` : '—'} mono />
            </div>
          </div>
        )}

        {multi && (
          <div>
            <div className="exif-section">
              <Row label="选中" value={`${multi.length} 张`} mono />
            </div>
            <MultiSummary shots={multi} />
          </div>
        )}
      </div>
    </aside>
  )
}

// Multi-shot summary: avoid per-photo detail fetches; instead show what we
// can derive from the shot list itself (rating distribution, format mix,
// pick count). EXIF detail isn't on the shot object, so it's left out.
function MultiSummary({ shots }) {
  const stars = { 3: 0, 2: 0, 1: 0, 0: 0, '-1': 0, na: 0 }
  let pick = 0, flying = 0, over = 0, under = 0
  const formats = new Map()
  for (const s of shots) {
    const r = s.rating
    if (r == null) stars.na++
    else stars[r] = (stars[r] ?? 0) + 1
    if (s.pick) pick++
    if (s.is_flying) flying++
    if (s.is_over) over++
    if (s.is_under) under++
    for (const f of s.formats || []) formats.set(f, (formats.get(f) ?? 0) + 1)
  }
  const fmtList = [...formats.entries()].map(([k,v]) => `${k}×${v}`).join(' ')
  return (
    <>
      <div className="exif-section">
        <Row label="★★★" value={stars[3]} mono />
        <Row label="★★" value={stars[2]} mono />
        <Row label="★" value={stars[1]} mono />
        <Row label="无星" value={stars[0]} mono />
        {stars['-1'] > 0 && <Row label="无鸟" value={stars['-1']} mono />}
      </div>
      <div className="exif-section">
        {pick > 0 && <Row label="精修" value={pick} mono />}
        {flying > 0 && <Row label="飞版" value={flying} mono />}
        {over > 0 && <Row label="过曝" value={over} mono />}
        {under > 0 && <Row label="欠曝" value={under} mono />}
      </div>
      {fmtList && (
        <div className="exif-section">
          <Row label="格式" value={fmtList} />
        </div>
      )}
    </>
  )
}
