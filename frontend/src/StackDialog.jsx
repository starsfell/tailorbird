import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'

// Multi-frame stacking dialog.
// Props:
//   shots        — list of shot objects (must include the selected ones)
//   selectedIds  — Set<primary_id>
//   onClose      — () => void

const PHASE_LABEL = {
  idle: '准备中…',
  loading: '解码',
  aligning: '特征对齐',
  merging: '合成像素',
  saving: '保存',
  done: '完成',
  error: '出错',
}

export function StackDialog({ shots, selectedIds, onClose, onCompareSources }) {
  const selected = useMemo(
    () => shots.filter(s => selectedIds.has(s.primary_id)),
    [shots, selectedIds]
  )

  // Default anchor = highest rating, then highest sharpness
  const defaultAnchor = useMemo(() => {
    if (!selected.length) return null
    const sorted = [...selected].sort((a, b) => {
      const ra = a.rating ?? -1, rb = b.rating ?? -1
      if (rb !== ra) return rb - ra
      const sa = a.subject_sharpness ?? 0, sb = b.subject_sharpness ?? 0
      return sb - sa
    })
    return sorted[0].primary_id
  }, [selected])

  const [anchorId, setAnchorId] = useState(defaultAnchor)
  useEffect(() => { setAnchorId(defaultAnchor) }, [defaultAnchor])

  const [source, setSource] = useState('jpeg')
  const [mode, setMode] = useState('sigma_clip')
  const [align, setAlign] = useState(true)
  const [fullSize, setFullSize] = useState(false)

  const [taskId, setTaskId] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const pollRef = useRef(null)

  const start = async () => {
    setError('')
    setStatus(null)
    try {
      const ids = selected.map(s => s.primary_id)
      const res = await api.startStack({
        photo_ids: ids,
        anchor_id: anchorId,
        source, mode, align,
        full_size: source === 'raw' ? fullSize : false,
      })
      setTaskId(res.task_id)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    const tick = async () => {
      try {
        const st = await api.stackStatus(taskId)
        if (cancelled) return
        setStatus(st)
        if (st.phase === 'done' || st.phase === 'error') return
      } catch (e) {
        if (!cancelled) setError(e.message)
        return
      }
      pollRef.current = setTimeout(tick, 600)
    }
    tick()
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current) }
  }, [taskId])

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const running = taskId && status && status.phase !== 'done' && status.phase !== 'error'
  const done = status && status.phase === 'done'
  const failed = (status && status.phase === 'error') || !!error

  const pct = status && status.total
    ? Math.round((status.done / status.total) * 100)
    : 0

  const reset = () => {
    setTaskId(null); setStatus(null); setError('')
  }

  return (
    <div className="stack-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="stack-modal">
        <div className="stack-head">
          <div className="stack-title">堆栈 {selected.length} 张</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>关闭 (Esc)</button>
        </div>

        {!done && !running && (
          <div className="stack-form">
            <div className="row">
              <label>锚帧</label>
              <select value={anchorId ?? ''} onChange={e => setAnchorId(Number(e.target.value))}>
                {selected.map(s => (
                  <option key={s.primary_id} value={s.primary_id}>
                    {s.stem} {s.rating != null && s.rating >= 0 ? '★'.repeat(s.rating) : ''}
                    {s.pick ? ' ◉' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <label>合成方式</label>
              <div className="seg">
                {[
                  ['sigma_clip', 'Sigma-clip (推荐)'],
                  ['median', '中值'],
                  ['mean', '均值'],
                ].map(([k, lab]) => (
                  <button
                    key={k}
                    className={mode === k ? 'on' : ''}
                    onClick={() => setMode(k)}
                  >{lab}</button>
                ))}
              </div>
            </div>
            <div className="row">
              <label>解码源</label>
              <div className="seg">
                <button className={source === 'jpeg' ? 'on' : ''} onClick={() => setSource('jpeg')}>
                  内嵌 JPEG (快)
                </button>
                <button className={source === 'raw' ? 'on' : ''} onClick={() => setSource('raw')}>
                  完整 RAW (慢/质量高)
                </button>
              </div>
            </div>
            <div className="row">
              <label>对齐</label>
              <label className="chk">
                <input type="checkbox" checked={align} onChange={e => setAlign(e.target.checked)} />
                自动对齐 (ORB 特征,推荐勾)
              </label>
            </div>
            {source === 'raw' && (
              <div className="row">
                <label>分辨率</label>
                <label className="chk">
                  <input type="checkbox" checked={fullSize} onChange={e => setFullSize(e.target.checked)} />
                  完整传感器尺寸 (A7R5 60MP,内存 ~{Math.round(selected.length * 0.7)}GB,慢但无像素损失)
                </label>
              </div>
            )}
            <div className="stack-hint">
              {source === 'raw'
                ? `RAW 模式:rawpy ${fullSize ? '全尺寸' : '半尺寸'} 16-bit 相机原生色 → Linear DNG (LR 可调白平衡/曝光),${selected.length} 张约 ${selected.length * (fullSize ? 8 : 3)}-${selected.length * (fullSize ? 15 : 5)}s`
                : `JPEG 模式:ARW 全分辨率内嵌预览 → JPEG q95,${selected.length} 张约 ${selected.length}-${selected.length * 2}s`}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <div style={{ flex: 1 }} />
              <button className="primary" onClick={start} disabled={!anchorId || selected.length < 2}>
                开始堆栈
              </button>
            </div>
          </div>
        )}

        {running && (
          <div className="stack-progress">
            <div className="stack-phase">
              {PHASE_LABEL[status.phase] || status.phase} · {status.done}/{status.total}
            </div>
            <div className="stack-bar"><div style={{ width: `${pct}%` }} /></div>
            <div className="stack-current">{status.current}</div>
          </div>
        )}

        {failed && (
          <div className="stack-error">
            <div>失败: {error || status?.error}</div>
            <button onClick={reset}>重试</button>
          </div>
        )}

        {done && (
          <div className="stack-result">
            <div className="stack-compare">
              <div className="half">
                <div className="lab">锚帧 ({selected.find(s => s.primary_id === anchorId)?.stem})</div>
                <img src={api.fullUrl(anchorId, 2400)} alt="anchor" />
              </div>
              <div className="half">
                <div className="lab">堆栈结果 · {selected.length} 张 · {mode} · {source}{source === 'raw' && fullSize ? ' · 全尺寸' : ''}</div>
                <img src={api.stackResultUrl(taskId, 'preview')} alt="stack" />
              </div>
            </div>
            <div className="stack-actions">
              <div className="stack-savepath">
                已保存到: <code title={status.result_path}>{status.result_path}</code>
              </div>
              <button
                onClick={() => {
                  if (!onCompareSources) return
                  // The stack image is ORB-aligned to the anchor frame, so its
                  // bird position matches the anchor. Inherit the anchor's
                  // eye_xy / bird_bbox so linked pan-zoom anchors all tiles
                  // (sources + stack) at the same point.
                  const anchorShot = selected.find(s => s.primary_id === anchorId)
                  const stackShot = {
                    primary_id: `stack-${taskId}`,
                    stem: `堆栈 ${selected.length}张`,
                    formats: [status.result_path.toLowerCase().endsWith('.dng') ? 'DNG' : 'JPG'],
                    member_ids: [],
                    tags: [],
                    shot_at: null,
                    rating: null,
                    pick: false,
                    is_flying: false, is_over: false, is_under: false,
                    eye_xy: anchorShot?.eye_xy ?? null,
                    bird_bbox: anchorShot?.bird_bbox ?? null,
                    subject_sharpness: null, eye_sharpness: null,
                    isStackResult: true,
                    imageUrl: api.stackResultUrl(taskId, 'preview'),
                    resultPath: status.result_path,
                  }
                  onCompareSources(stackShot, selectedIds)
                }}
                title="把堆栈结果和所有原图一起拉进对比视图(联动放大)"
              >
                对比所有原图
              </button>
              <button onClick={() => api.revealPath(status.result_path).catch(e => setError(e.message))}>
                在 Finder 中显示
              </button>
              <button onClick={() => {
                const dir = status.result_path.replace(/\/[^/]+$/, '')
                api.revealPath(dir).catch(e => setError(e.message))
              }}>
                打开文件夹
              </button>
              <button onClick={reset}>再堆一次</button>
              <button className="primary" onClick={onClose}>完成</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
