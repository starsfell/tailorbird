import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { Tile } from './Tile.jsx'
import { buildTagTree, tagPath } from './tagTree.js'

// Triage view: a tag-first workspace for fast inbox-style processing.
//   • Left panel: tag tree. Top 9 favorites get keyboard shortcuts 1-9.
//   • Center: thumbnail grid; double-click opens DetailView.
//   • Drag a tag row onto the grid → attach to currently selected shots.
//   • Press a digit → toggle the bound favorite tag for current selection.

function TagTreeRow({
  node, depth, byId, expandedIds, toggleExpand, hotkeys,
  searchTerm, onContext,
}) {
  const has = node.children.length > 0
  const expanded = expandedIds.has(node.id) || !!searchTerm
  const hk = hotkeys.get(node.id)
  return (
    <>
      <div
        className="triage-row"
        style={{ paddingLeft: 6 + depth * 12 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-tailorbird-tag', String(node.id))
          e.dataTransfer.effectAllowed = 'copy'
          e.currentTarget.classList.add('dragging')
        }}
        onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
        onClick={(e) => { e.stopPropagation(); if (has) toggleExpand(node.id) }}
        onContextMenu={(e) => { e.preventDefault(); onContext?.(node, { x: e.clientX, y: e.clientY }) }}
        title={tagPath(byId, node.id).join(' / ')}
      >
        <span style={{ width: 10, color:'var(--muted)' }}>{has ? (expanded ? '▾' : '▸') : ''}</span>
        <span className="hotkey">{hk ?? ''}</span>
        <span className="swatch" style={node.color ? { background: node.color } : undefined} />
        <span style={{flex:'1 1 auto', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {node.name}
          {node.is_favorite ? <span style={{color:'#ffd866', marginLeft:4}}>★</span> : null}
        </span>
        <span className="count">{node.usage_count}</span>
      </div>
      {has && expanded && node.children.map(c => (
        <TagTreeRow key={c.id} node={c} depth={depth + 1} byId={byId}
          expandedIds={expandedIds} toggleExpand={toggleExpand}
          hotkeys={hotkeys} searchTerm={searchTerm} onContext={onContext}
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

export function TriageView({
  folder, setFolder, folders,
  allTags, onTagsChanged,
  selected, setSelected, onOpen,
}) {
  const [scope, setScope] = useState(folder || 'all')   // 'all' or a folder path
  const [shots, setShots] = useState([])
  const [loading, setLoading] = useState(false)
  const [untaggedOnly, setUntaggedOnly] = useState(false)
  const [sortBy, setSortBy] = useState('time')           // 'time' | 'rating'
  const [q, setQ] = useState('')                         // tag search
  const [expandedIds, setExpandedIds] = useState(new Set())
  const [dropActive, setDropActive] = useState(false)
  const lastClickRef = useRef(null)

  // Sync local scope when external folder changes (cross-tab)
  useEffect(() => { setScope(folder || 'all') }, [folder])

  // Fetch shots whenever scope or filter changes.
  const refetch = async () => {
    setLoading(true)
    try {
      const params = { limit: 5000 }
      if (scope && scope !== 'all') params.folder = scope
      if (untaggedOnly) params.untagged = true
      const r = await api.listShots(params)
      let items = r.items || []
      if (sortBy === 'rating') {
        items = [...items].sort((a, b) => (b.rating ?? -2) - (a.rating ?? -2) || (a.shot_at ?? 0) - (b.shot_at ?? 0))
      }
      setShots(items)
    } finally { setLoading(false) }
  }
  useEffect(() => { refetch() }, [scope, untaggedOnly, sortBy])

  const { roots, byId } = useMemo(() => buildTagTree(allTags), [allTags])
  const pruned = useMemo(() => prune(roots, q.trim()), [roots, q])

  // First 9 favorites (in tree order) get 1-9 hotkeys.
  const hotkeys = useMemo(() => {
    const m = new Map()
    let idx = 1
    const walk = (nodes) => {
      for (const n of nodes) {
        if (idx > 9) return
        if (n.is_favorite) { m.set(n.id, idx++); if (idx > 9) return }
        walk(n.children)
      }
    }
    walk(roots)
    return m
  }, [roots])
  const hotkeyTagById = useMemo(() => {
    const m = new Map()
    for (const [id, n] of hotkeys.entries()) m.set(n, id)
    return m
  }, [hotkeys])

  const toggleExpand = (id) => setExpandedIds(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  const handleSelect = (id, e) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (e?.shiftKey && lastClickRef.current != null) {
        const ids = shots.map(s => s.primary_id)
        const a = ids.indexOf(lastClickRef.current)
        const b = ids.indexOf(id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          for (let i = lo; i <= hi; i++) next.add(ids[i])
        }
      } else if (e?.metaKey || e?.ctrlKey) {
        if (next.has(id)) next.delete(id); else next.add(id)
      } else {
        next.clear(); next.add(id)
      }
      return next
    })
    lastClickRef.current = id
  }

  const onDrop = async (e) => {
    e.preventDefault()
    setDropActive(false)
    const tagId = e.dataTransfer.getData('application/x-tailorbird-tag')
    if (!tagId || selected.size === 0) return
    try {
      await api.batchPhotoTags([...selected], { add_tag_ids: [parseInt(tagId, 10)] })
      onTagsChanged?.()
      await refetch()
    } catch (err) { alert('打标失败: ' + err.message) }
  }

  // Keyboard 1-9: toggle the hot-keyed tag for the current selection.
  useEffect(() => {
    const onKey = async (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!/^[1-9]$/.test(e.key)) return
      const tagId = hotkeyTagById.get(parseInt(e.key, 10))
      if (!tagId || selected.size === 0) return
      e.preventDefault()
      // Determine current state: all selected have this tag → remove; else add.
      const selectedShots = shots.filter(s => selected.has(s.primary_id))
      const all = selectedShots.every(s => (s.tags || []).some(t => t.id === tagId))
      try {
        if (all) await api.batchPhotoTags([...selected], { remove_tag_ids: [tagId] })
        else await api.batchPhotoTags([...selected], { add_tag_ids: [tagId] })
        onTagsChanged?.()
        await refetch()
      } catch (err) { alert('打标失败: ' + err.message) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeyTagById, selected, shots])

  const favRoots = pruned.filter(n => n.is_favorite)
  const nonFavRoots = pruned.filter(n => !n.is_favorite)
  const renderRow = (n) => (
    <TagTreeRow key={n.id} node={n} depth={0} byId={byId}
      expandedIds={expandedIds} toggleExpand={toggleExpand}
      hotkeys={hotkeys} searchTerm={q.trim()}
    />
  )

  const untaggedCount = useMemo(
    () => shots.filter(s => !s.tags || s.tags.length === 0).length,
    [shots],
  )

  return (
    <div className="triage">
      <aside className="triage-sidebar">
        <div style={{padding:'10px 12px', borderBottom:'1px solid var(--border)'}}>
          <input type="text" placeholder="搜索标签…" value={q}
            onChange={(e) => setQ(e.target.value)} style={{width:'100%'}} />
          <div style={{fontSize:11, color:'var(--muted)', marginTop:6}}>
            常用前 9 个 → 数字键 <span style={{color:'var(--accent)'}}>1-9</span> 切换。拖标签到右侧 → 加给选中。
          </div>
        </div>
        <div style={{padding:'8px 10px', overflowY:'auto', flex:'1 1 auto'}}>
          {favRoots.length > 0 && (<><div className="section-title">常用</div>{favRoots.map(renderRow)}</>)}
          {nonFavRoots.length > 0 && (<>
            {favRoots.length > 0 && <div className="section-title">全部</div>}
            {nonFavRoots.map(renderRow)}
          </>)}
          {pruned.length === 0 && (
            <div style={{color:'var(--muted)', fontSize:12, padding:'10px 0'}}>
              {allTags.length === 0 ? '暂无标签 — 在详情页输入或这里没意义,先去主页扫描点照片' : '无匹配'}
            </div>
          )}
        </div>
      </aside>
      <div className="triage-main">
        <div className="triage-toolbar">
          <span style={{color:'var(--muted)'}}>范围</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">所有文件夹</option>
            {folders.map(f => (
              <option key={f.id} value={f.path}>{f.path.replace(/^.*\//, '')}</option>
            ))}
          </select>
          <label style={{display:'flex', alignItems:'center', gap:4}}>
            <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} />
            仅未打标
          </label>
          <span style={{color:'var(--muted)', marginLeft:8}}>排序</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="time">时间</option>
            <option value="rating">星级</option>
          </select>
          <div style={{marginLeft:'auto', color:'var(--muted)'}}>
            {loading ? '加载中…' : <>
              {shots.length} shot · 未打标 {untaggedCount} · 已选 {selected.size}
            </>}
          </div>
        </div>
        <div className={'triage-grid-wrap' + (dropActive ? ' drop-active' : '')}
          onDragOver={(e) => {
            if ([...e.dataTransfer.types].includes('application/x-tailorbird-tag')) {
              e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true)
            }
          }}
          onDragLeave={(e) => {
            // Only clear when leaving the container entirely
            if (e.currentTarget === e.target) setDropActive(false)
          }}
          onDrop={onDrop}
        >
          {shots.length === 0 ? (
            <div style={{padding:40, color:'var(--muted)', textAlign:'center'}}>
              {loading ? '加载中…' : untaggedOnly ? '当前范围内全部打过标了 🎉' : '没有照片 — 先在主页扫描一个目录'}
            </div>
          ) : (
            <div className="grid">
              {shots.map(s => (
                <div key={s.primary_id} onClick={(e) => handleSelect(s.primary_id, e)}>
                  <Tile
                    shot={s}
                    selected={selected.has(s.primary_id)}
                    onToggle={() => {}}   /* handled by wrapper div for shift/cmd-click */
                    onOpen={onOpen}
                    showTags
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
