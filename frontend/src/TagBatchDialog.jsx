import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { buildTagTree, tagPath } from './tagTree.js'

// Dialog for applying tags to a multi-selected set of shots, rendered as a tree.
// Each tag has tri-state w.r.t. its direct attachment count across the selection:
//   none    — 0 shots have it directly attached    → click to add to all
//   partial — some shots have it                   → click to add to remaining
//   all     — every shot has it                    → click to remove from all
function TreeRow({ node, depth, byId, expandedIds, toggleExpand, counts, total, onClick, busy, searchTerm }) {
  const has = node.children.length > 0
  const expanded = expandedIds.has(node.id) || !!searchTerm
  const c = counts.get(node.id) || 0
  const state = c === 0 ? 'none' : (c === total ? 'all' : 'partial')
  const bg = state === 'all' ? '#1f3a32' : state === 'partial' ? '#2a2419' : 'transparent'
  const border = state === 'all' ? '#2d5547' : state === 'partial' ? '#5a4a25' : 'var(--border)'
  return (
    <>
      <div
        style={{
          display:'flex', alignItems:'center', gap:6,
          padding:'4px 8px', borderRadius:4,
          background: bg, border: `1px solid ${border}`,
          marginBottom: 2, cursor: busy ? 'wait' : 'pointer',
          paddingLeft: 8 + depth * 14,
        }}
        title={tagPath(byId, node.id).join(' / ') + ' — ' + (state === 'all' ? '全部已加 (点击全移)' : state === 'partial' ? `${c}/${total} 部分有 (点击补齐)` : '点击加到全部')}
        onClick={() => onClick(node)}
      >
        <span onClick={(e) => { e.stopPropagation(); if (has) toggleExpand(node.id) }}
          style={{ width: 12, display:'inline-block', textAlign:'center', color:'var(--muted)' }}>
          {has ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="swatch" style={{
          width: 8, height: 8, borderRadius:'50%',
          background: node.color || 'var(--border)', flex:'none',
        }} />
        <span style={{flex:'1 1 auto', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {state === 'none' ? '+ ' : ''}{node.name}
          {node.is_favorite ? <span style={{color:'#ffd866', marginLeft:4}}>★</span> : null}
        </span>
        {state === 'partial' && <span style={{fontSize:10, color:'#ffd866'}}>{c}/{total}</span>}
        {state === 'all' && <span style={{fontSize:10, color:'var(--accent)'}}>✓</span>}
      </div>
      {has && expanded && node.children.map(child => (
        <TreeRow key={child.id} node={child} depth={depth + 1} byId={byId}
          expandedIds={expandedIds} toggleExpand={toggleExpand}
          counts={counts} total={total} onClick={onClick} busy={busy} searchTerm={searchTerm}
        />
      ))}
    </>
  )
}

function prune(roots, term) {
  if (!term) return roots
  const lower = term.toLowerCase()
  const visit = (n) => {
    const kept = n.children.map(visit).filter(Boolean)
    if (n.name.toLowerCase().includes(lower) || kept.length > 0) return { ...n, children: kept }
    return null
  }
  return roots.map(visit).filter(Boolean)
}

export function TagBatchDialog({ shots, selectedIds, onClose, onApplied }) {
  const [allTags, setAllTags] = useState([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const inputRef = useRef(null)

  useEffect(() => {
    api.listTags().then(r => setAllTags(r.tags || [])).catch(() => {})
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const toggleExpand = (id) => setExpandedIds(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  const selectedShots = useMemo(
    () => shots.filter(s => selectedIds.has(s.primary_id)),
    [shots, selectedIds],
  )
  const total = selectedShots.length

  const counts = useMemo(() => {
    const m = new Map()
    for (const s of selectedShots) for (const t of (s.tags || [])) m.set(t.id, (m.get(t.id) || 0) + 1)
    return m
  }, [selectedShots])

  const { roots, byId } = useMemo(() => buildTagTree(allTags), [allTags])
  const q = text.trim()
  const pruned = useMemo(() => prune(roots, q), [roots, q])

  const refreshAll = async () => {
    const r = await api.listTags()
    setAllTags(r.tags || [])
  }

  const clickTag = async (t) => {
    if (busy) return
    setBusy(true)
    const c = counts.get(t.id) || 0
    const state = c === 0 ? 'none' : (c === total ? 'all' : 'partial')
    try {
      if (state === 'all') {
        await api.batchPhotoTags([...selectedIds], { remove_tag_ids: [t.id] })
      } else {
        await api.batchPhotoTags([...selectedIds], { add_tag_ids: [t.id] })
      }
      await onApplied?.()
      await refreshAll()
    } finally { setBusy(false) }
  }

  const createAndApply = async () => {
    const name = text.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await api.batchPhotoTags([...selectedIds], { add_tag_names: [name] })
      setText('')
      await onApplied?.()
      await refreshAll()
    } finally { setBusy(false) }
  }

  const pathOf = (id) => tagPath(byId, id).join(' / ')
  const exactExists = q && allTags.some(t => pathOf(t.id).toLowerCase() === q.toLowerCase() || t.name.toLowerCase() === q.toLowerCase())

  return (
    <div className="dlg-overlay" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{width: 520}}>
        <div className="dlg-head">
          <span>给 {total} 个 shot 加/移标签</span>
          <button onClick={onClose}>Esc 关闭</button>
        </div>
        <div className="dlg-body">
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索 / 回车创建 (支持 父/子/孙)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const existing = allTags.find(t => pathOf(t.id).toLowerCase() === q.toLowerCase()) ||
                                 allTags.find(t => !q.includes('/') && t.name.toLowerCase() === q.toLowerCase())
                if (existing) clickTag(existing)
                else createAndApply()
              } else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }}
            style={{width:'100%', marginBottom:8}}
          />
          <div style={{marginBottom:8}}>
            {pruned.map(n => (
              <TreeRow key={n.id} node={n} depth={0} byId={byId}
                expandedIds={expandedIds} toggleExpand={toggleExpand}
                counts={counts} total={total} onClick={clickTag} busy={busy}
                searchTerm={q}
              />
            ))}
            {pruned.length === 0 && (
              <div style={{color:'var(--muted)', fontSize:12, padding:'10px 0'}}>
                {allTags.length === 0 ? '暂无标签 — 输入名字后回车创建' : '无匹配'}
              </div>
            )}
          </div>
          {q && !exactExists && (
            <button className="primary" onClick={createAndApply} disabled={busy}
              style={{width:'100%'}}>+ 创建 "{q}"{q.includes('/') ? ' (路径)' : ''} 并加到全部</button>
          )}
          <div style={{color:'var(--muted)', fontSize:11, marginTop:8}}>
            点击说明:全部已加 → 全移;部分有 → 补齐;全无 → 全加。子节点 click 只影响该节点的直接绑定;
            筛选时父节点的祖先包含语义在主页面/中心页生效。
          </div>
        </div>
      </div>
    </div>
  )
}
