import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'

const PRESET_COLORS = [
  '#e85a5a', '#f29b3a', '#ffd866', '#4dd0a0', '#5a78ff', '#b88cff', '#ff6fa3',
]

// Bottom quick bar for tagging a set of shots in Compare.
// `shots` is the picked set (1 or more). Operations apply to all of them.
// Tri-state for partial tags: chip shows count "N/M" when some-but-not-all have it.
export function TagQuickBar({ shots, allTags, onApplied, onClose }) {
  const [text, setText] = useState('')
  const [newColor, setNewColor] = useState(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  // No autofocus on activation: that would steal the keyboard from global
  // shortcuts like R (reveal) / S (link) / 0 (reset). User clicks the input
  // explicitly when they want to type a tag.

  const list = shots || []
  const total = list.length

  // Union of attached tags with per-tag counts across the picked set.
  const { attachedById, attachedList, counts } = useMemo(() => {
    const byId = new Map()
    const c = new Map()
    for (const s of list) {
      for (const t of (s.tags || [])) {
        if (!byId.has(t.id)) byId.set(t.id, t)
        c.set(t.id, (c.get(t.id) || 0) + 1)
      }
    }
    return {
      attachedById: byId,
      attachedList: [...byId.values()],
      counts: c,
    }
  }, [list])

  const quickPicks = useMemo(() => {
    const used = new Set(attachedById.keys())
    // Only show 'all-applied' tags as removable chips; partial and unused both as quick add.
    const pool = (allTags || []).filter(t => !used.has(t.id) || (counts.get(t.id) || 0) < total)
    pool.sort((a, b) => {
      const fa = a.is_favorite ? 1 : 0
      const fb = b.is_favorite ? 1 : 0
      if (fa !== fb) return fb - fa
      return (a.name || '').localeCompare(b.name || '')
    })
    return pool.slice(0, 14)
  }, [allTags, attachedById, counts, total])

  const targetIds = () => list.map(s => s.primary_id)

  const runApply = async (fn) => {
    if (busy || total === 0) return
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
    await onApplied?.()
  }

  const addExisting = (t) => runApply(() =>
    api.batchPhotoTags(targetIds(), { add_tag_ids: [t.id] })
  )
  const removeOne = (t) => runApply(() =>
    api.batchPhotoTags(targetIds(), { remove_tag_ids: [t.id] })
  )
  const createAndApply = async () => {
    const name = text.trim()
    if (!name) return
    await runApply(async () => {
      const ids = targetIds()
      if (newColor) {
        const created = await api.createTag(name, { color: newColor })
        await api.batchPhotoTags(ids, { add_tag_ids: [created.id] })
      } else {
        await api.batchPhotoTags(ids, { add_tag_names: [name] })
      }
    })
    setText('')
  }

  if (total === 0) return null

  // Build a short label: single stem, or first stems + "…"
  const headerLabel = total === 1
    ? list[0].stem
    : `${total} 张 (${list.slice(0, 3).map(s => s.stem).join(', ')}${total > 3 ? '…' : ''})`

  return (
    <div className="tag-quickbar" onClick={(e) => e.stopPropagation()}>
      <div className="qb-row">
        <span className="qb-target">
          <span style={{color:'var(--muted)', fontSize:11}}>给</span>
          <strong style={{margin:'0 6px'}}>{headerLabel}</strong>
        </span>
        <button onClick={onClose} style={{padding:'2px 8px'}}>关闭</button>
      </div>

      <div className="qb-row qb-tags">
        {attachedList.length === 0 && <span className="qb-empty">这批照片还没有标签</span>}
        {attachedList.map(t => {
          const cnt = counts.get(t.id) || 0
          const isAll = cnt === total
          const partialLabel = !isAll ? ` (${cnt}/${total})` : ''
          return (
            <span
              key={t.id}
              className={'tag-chip ' + (isAll ? 'applied' : 'partial')}
              style={isAll && t.color
                ? { background: t.color, color: '#0a0a0a', borderColor: t.color }
                : undefined}
              title={isAll ? '点 × 从全部移除' : `${cnt}/${total} 张有此标签 — 点 × 全部移除,点名字补到剩余`}
            >
              <span onClick={() => !isAll && addExisting(t)}>{t.name}{partialLabel}</span>
              <span className="x" onClick={() => removeOne(t)}>×</span>
            </span>
          )
        })}
        {quickPicks.map(t => (
          <span
            key={t.id}
            className="tag-chip quick"
            style={t.color ? { borderColor: t.color, color: t.color } : undefined}
            onClick={() => addExisting(t)}
            title="点击给所有选中添加"
          >+ {t.name}</span>
        ))}
      </div>

      <div className="qb-row qb-create">
        <input
          ref={inputRef}
          type="text"
          placeholder="新建/搜索标签 (回车创建)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); createAndApply() }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
        />
        <span className="qb-swatches" title="新标签颜色">
          <span
            className={'swatch-pick none' + (newColor === null ? ' on' : '')}
            onClick={() => setNewColor(null)}
            title="无色"
          />
          {PRESET_COLORS.map(c => (
            <span
              key={c}
              className={'swatch-pick' + (newColor === c ? ' on' : '')}
              style={{ background: c }}
              onClick={() => setNewColor(c)}
              title={c}
            />
          ))}
        </span>
        <button className="primary" onClick={createAndApply} disabled={!text.trim() || busy}>
          + 创建并添加
        </button>
      </div>
    </div>
  )
}
