import React, { useMemo, useState } from 'react'
import { buildTagTree, tagPath } from './tagTree.js'

function PickerRow({ node, depth, byId, excludeIds, expandedIds, toggleExpand, onPick, searchTerm }) {
  const has = node.children.length > 0
  const expanded = expandedIds.has(node.id) || !!searchTerm
  const blocked = excludeIds.has(node.id)
  return (
    <>
      <div
        className="tag-row"
        style={{
          paddingLeft: 6 + depth * 14,
          cursor: blocked ? 'not-allowed' : 'pointer',
          opacity: blocked ? 0.4 : 1,
        }}
        onClick={() => { if (!blocked) onPick(node.id) }}
      >
        <span className="name" style={{ minWidth: 0 }}>
          <span
            onClick={(e) => { e.stopPropagation(); if (has) toggleExpand(node.id) }}
            style={{ width: 12, display:'inline-block', textAlign:'center', color:'var(--muted)' }}
          >{has ? (expanded ? '▾' : '▸') : ''}</span>
          <span className="swatch" style={node.color ? { background: node.color } : undefined} />
          <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}
            title={tagPath(byId, node.id).join(' / ')}>{node.name}</span>
        </span>
      </div>
      {has && expanded && node.children.map(c => (
        <PickerRow key={c.id} node={c} depth={depth + 1} byId={byId}
          excludeIds={excludeIds} expandedIds={expandedIds} toggleExpand={toggleExpand}
          onPick={onPick} searchTerm={searchTerm}
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

export function TagPickerDialog({ title, allTags, excludeIds = new Set(), allowRoot = true, onPick, onClose }) {
  const [q, setQ] = useState('')
  const [expandedIds, setExpandedIds] = useState(new Set())
  const toggle = (id) => setExpandedIds(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })
  const { roots, byId } = useMemo(() => buildTagTree(allTags), [allTags])
  const pruned = useMemo(() => prune(roots, q.trim()), [roots, q])

  return (
    <div className="dlg-overlay" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <span>{title || '选择标签'}</span>
          <button onClick={onClose}>Esc 关闭</button>
        </div>
        <div className="dlg-body">
          <input type="text" placeholder="搜索…" value={q}
            onChange={(e) => setQ(e.target.value)} style={{width:'100%', marginBottom:8}} />
          {allowRoot && (
            <div className="tag-row" style={{ paddingLeft: 6, color:'var(--accent)' }}
              onClick={() => onPick(null)}>
              <span className="name">— 根级(无父)</span>
            </div>
          )}
          {pruned.map(n => (
            <PickerRow key={n.id} node={n} depth={0} byId={byId}
              excludeIds={excludeIds} expandedIds={expandedIds} toggleExpand={toggle}
              onPick={onPick} searchTerm={q.trim()}
            />
          ))}
          {pruned.length === 0 && (
            <div style={{color:'var(--muted)', fontSize:12, padding:'10px 0'}}>
              {allTags.length === 0 ? '暂无标签' : '无匹配'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
