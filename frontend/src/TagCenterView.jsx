import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { Grid } from './Grid.jsx'
import { buildTagTree, descendantIds, tagPath } from './tagTree.js'
import { TagPickerDialog } from './TagPickerDialog.jsx'
import { TagExportDialog } from './TagExportDialog.jsx'

const PRESET_COLORS = [
  null, '#e85a5a', '#f29b3a', '#ffd866', '#4dd0a0', '#5a78ff', '#b88cff', '#ff6fa3',
]

function TagContextMenu({ tag, anchor, onClose, onChanged, onDeleted, onMove, onExport, onQuickMove }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(tag.name)
  const [creating, setCreating] = useState(false)
  const [childName, setChildName] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { if (renaming || creating) setTimeout(() => inputRef.current?.focus(), 30) }, [renaming, creating])
  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest?.('.ctx-menu') && !e.target.closest?.('.dlg-overlay')) onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const doRename = async () => {
    const n = name.trim(); if (!n || n === tag.name) { setRenaming(false); return }
    try { await api.updateTag(tag.id, { name: n }); onChanged?.(); onClose() }
    catch (e) { alert('改名失败: ' + e.message) }
  }
  const setColor = async (c) => { await api.updateTag(tag.id, { color: c }); onChanged?.(); onClose() }
  const toggleFav = async () => { await api.updateTag(tag.id, { is_favorite: !tag.is_favorite }); onChanged?.(); onClose() }
  const doDelete = async (mode) => {
    const labels = { lift: '保留子标签(升到父级)', orphan: '保留子标签(变根节点)', cascade: '同时删除所有子标签' }
    const ok = window.confirm(`删除标签「${tag.name}」?\n  · ${labels[mode]}\n  · 会从 ${tag.usage_count} 张直接引用此 tag 的照片移除`)
    if (!ok) return
    await api.deleteTag(tag.id, mode); onDeleted?.(); onClose()
  }
  const doCreateChild = async () => {
    const n = childName.trim(); if (!n) { setCreating(false); return }
    await api.createTag(n, { parent_id: tag.id }); onChanged?.(); onClose()
  }

  const style = (() => {
    const pad = 8
    const x = Math.min(anchor.x, window.innerWidth - 220 - pad)
    const y = Math.min(anchor.y, window.innerHeight - 320 - pad)
    return { left: Math.max(pad, x), top: Math.max(pad, y) }
  })()

  return (
    <div className="ctx-menu" style={style} onClick={(e) => e.stopPropagation()}>
      {renaming ? (
        <div style={{padding:4}}>
          <input ref={inputRef} type="text" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); doRename() }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) }
            }} />
          <div style={{display:'flex', gap:4, marginTop:6, justifyContent:'flex-end'}}>
            <button onClick={() => setRenaming(false)}>取消</button>
            <button className="primary" onClick={doRename}>保存</button>
          </div>
        </div>
      ) : creating ? (
        <div style={{padding:4}}>
          <div style={{fontSize:11, color:'var(--muted)', marginBottom:4}}>在「{tag.name}」下新建子标签</div>
          <input ref={inputRef} type="text" value={childName} placeholder="子标签名"
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); doCreateChild() }
              else if (e.key === 'Escape') { e.preventDefault(); setCreating(false) }
            }} />
          <div style={{display:'flex', gap:4, marginTop:6, justifyContent:'flex-end'}}>
            <button onClick={() => setCreating(false)}>取消</button>
            <button className="primary" onClick={doCreateChild}>创建</button>
          </div>
        </div>
      ) : (
        <>
          <div className="item" onClick={() => setRenaming(true)}>✎ 改名</div>
          <div className="item" onClick={() => setCreating(true)}>➕ 新建子标签</div>
          <div className="item" onClick={() => onMove?.(tag)}>↪ 移到分组…</div>
          <div className="item" onClick={toggleFav}>{tag.is_favorite ? '☆ 取消常用' : '★ 设为常用'}</div>
          <div className="sep" />
          <div className="item" onClick={() => onQuickMove?.(tag)}>📂 移到「{tag.name}」子文件夹</div>
          <div className="item" onClick={() => onExport?.(tag)} style={{fontSize:11, color:'var(--muted)'}}>📦 导出到外置盘…(自定义)</div>
          <div className="sep" />
          <div style={{fontSize:11, color:'var(--muted)', padding:'4px 10px'}}>颜色</div>
          <div className="swatches">
            {PRESET_COLORS.map((c, i) => (
              <div key={i}
                className={'swatch-pick' + (c === null ? ' none' : '')}
                style={{ background: c || undefined }}
                onClick={() => setColor(c)} title={c || '无'} />
            ))}
          </div>
          <div className="sep" />
          <div className="item danger" onClick={() => doDelete('lift')}>🗑 删除(子升级父级)</div>
          <div className="item danger" onClick={() => doDelete('cascade')}>🗑 删除全部(含子)</div>
        </>
      )}
    </div>
  )
}

function TreeRow({ node, depth, byId, expandedIds, toggleExpand, selectedIds, onToggle, searchTerm, onContext }) {
  const has = node.children.length > 0
  const expanded = expandedIds.has(node.id) || !!searchTerm
  const active = selectedIds.has(node.id)
  return (
    <>
      <div className={'tag-row' + (active ? ' active' : '')}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onToggle(node.id)}
        onContextMenu={(e) => { e.preventDefault(); onContext(node, { x: e.clientX, y: e.clientY }) }}>
        <span className="name" style={{ minWidth: 0 }}>
          <span onClick={(e) => { e.stopPropagation(); if (has) toggleExpand(node.id) }}
            style={{ width: 12, display:'inline-block', textAlign:'center', color:'var(--muted)', cursor: has ? 'pointer' : 'default' }}>
            {has ? (expanded ? '▾' : '▸') : ''}
          </span>
          <span className="swatch" style={node.color ? { background: node.color } : undefined} />
          <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}
            title={tagPath(byId, node.id).join(' / ')}>
            {node.name}
            {node.is_favorite ? <span style={{color:'#ffd866', marginLeft:4}}>★</span> : null}
          </span>
        </span>
        <span className="count">{node.usage_count}</span>
        <button className="more" onClick={(e) => { e.stopPropagation(); onContext(node, { x: e.clientX, y: e.clientY }) }}>⋯</button>
      </div>
      {has && expanded && node.children.map(c => (
        <TreeRow key={c.id} node={c} depth={depth + 1} byId={byId}
          expandedIds={expandedIds} toggleExpand={toggleExpand}
          selectedIds={selectedIds} onToggle={onToggle}
          searchTerm={searchTerm} onContext={onContext}
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

export function TagCenterView({
  allTags, tagFilter, setTagFilter, filterMode, setFilterMode,
  onTagsChanged, selected, setSelected, onOpen,
}) {
  const [q, setQ] = useState('')
  const [shots, setShots] = useState([])
  const [loading, setLoading] = useState(false)
  const [ctx, setCtx] = useState(null)
  const [moveTarget, setMoveTarget] = useState(null)
  const [exportTarget, setExportTarget] = useState(null)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const [shotsTick, setShotsTick] = useState(0)
  const toggleExpand = (id) => setExpandedIds(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (tagFilter.size === 0) { setShots([]); return }
      setLoading(true)
      try {
        const r = await api.listShots({
          tag_ids: [...tagFilter].join(','), tag_mode: filterMode, limit: 5000,
        })
        if (!cancelled) setShots(r.items || [])
      } finally { if (!cancelled) setLoading(false) }
    }
    run()
    return () => { cancelled = true }
  }, [tagFilter, filterMode, shotsTick])

  const { roots, byId } = useMemo(() => buildTagTree(allTags), [allTags])
  const pruned = useMemo(() => prune(roots, q.trim()), [roots, q])

  const toggle = (id) => setTagFilter(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })
  const favRoots = pruned.filter(n => n.is_favorite)
  const nonFavRoots = pruned.filter(n => !n.is_favorite)
  const renderRow = (n) => (
    <TreeRow key={n.id} node={n} depth={0} byId={byId}
      expandedIds={expandedIds} toggleExpand={toggleExpand}
      selectedIds={tagFilter} onToggle={toggle}
      searchTerm={q.trim()} onContext={(tag, anchor) => setCtx({ tag, anchor })}
    />
  )

  return (
    <div className="tag-center">
      <aside className="tag-center-sidebar">
        <div style={{padding:'10px 12px', borderBottom:'1px solid var(--border)'}}>
          <input type="text" placeholder="搜索标签…" value={q}
            onChange={(e) => setQ(e.target.value)} style={{width:'100%', padding:'4px 8px', fontSize:12}} />
          <div className="panel-mode" style={{display:'flex', gap:2, marginTop:8}}>
            <button className={filterMode === 'or' ? 'active' : ''} onClick={() => setFilterMode('or')}>任一 (OR)</button>
            <button className={filterMode === 'and' ? 'active' : ''} onClick={() => setFilterMode('and')}>全部 (AND)</button>
          </div>
          {tagFilter.size > 0 && (
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:8}}>
              <span style={{fontSize:11, color:'var(--muted)'}}>已选 {tagFilter.size}</span>
              <button onClick={() => setTagFilter(new Set())} style={{padding:'2px 6px', fontSize:11}}>清空</button>
            </div>
          )}
        </div>
        <div style={{padding:'8px 10px', overflowY:'auto', flex:'1 1 auto'}}>
          {favRoots.length > 0 && (<><div className="section-title">常用</div>{favRoots.map(renderRow)}</>)}
          {nonFavRoots.length > 0 && (<>
            {favRoots.length > 0 && <div className="section-title">全部</div>}
            {nonFavRoots.map(renderRow)}
          </>)}
          {pruned.length === 0 && (
            <div style={{color:'var(--muted)', fontSize:12, padding:'10px 0'}}>
              {allTags.length === 0 ? '暂无标签' : '无匹配'}
            </div>
          )}
        </div>
      </aside>
      <div className="tag-center-main">
        {tagFilter.size === 0 ? (
          <div style={{padding:40, color:'var(--muted)', fontSize:13, textAlign:'center'}}>
            从左侧选一个或多个标签开始浏览(点中间节点会含所有后裔)
          </div>
        ) : loading ? (
          <div style={{padding:40, color:'var(--muted)'}}>加载中…</div>
        ) : shots.length === 0 ? (
          <div style={{padding:40, color:'var(--muted)'}}>没有匹配的照片</div>
        ) : (
          <>
            <div style={{padding:'8px 14px', fontSize:12, color:'var(--muted)', borderBottom:'1px solid var(--border)'}}>
              跨文件夹 · {shots.length} shot · 模式 {filterMode === 'and' ? '全部命中' : '任一命中'}
            </div>
            <div style={{padding:14, overflowY:'auto', flex:'1 1 auto'}}>
              <Grid shots={shots} selected={selected} setSelected={setSelected} onOpen={onOpen} />
            </div>
          </>
        )}
      </div>
      {ctx && (
        <TagContextMenu tag={ctx.tag} anchor={ctx.anchor}
          onClose={() => setCtx(null)}
          onChanged={onTagsChanged}
          onMove={(tag) => { setCtx(null); setMoveTarget(tag) }}
          onExport={(tag) => { setCtx(null); setExportTarget(tag) }}
          onQuickMove={async (tag) => {
            setCtx(null)
            const ok = window.confirm(`把所有打了「${tag.name}」(含子标签)的照片移到各自源目录下的 ${tag.name}/ 子文件夹? (ARW+HIF 配对)`)
            if (!ok) return
            try {
              const r = await api.moveTagToSubfolder(tag.id)
              onTagsChanged?.()
              setShotsTick(t => t + 1)
              const n = r.moved?.length || 0
              const f = r.failed?.length || 0
              if (f) alert(`完成: 移走 ${n} 张,${f} 失败`)
            } catch (e) { alert('移动失败: ' + e.message) }
          }}
          onDeleted={() => {
            setTagFilter(prev => {
              if (!prev.has(ctx.tag.id)) return prev
              const n = new Set(prev); n.delete(ctx.tag.id); return n
            })
            onTagsChanged?.()
          }}
        />
      )}
      {moveTarget && (
        <TagPickerDialog
          title={`移动「${moveTarget.name}」到…`}
          allTags={allTags}
          excludeIds={new Set([moveTarget.id, ...descendantIds(byId, moveTarget.id)])}
          allowRoot
          onPick={async (parentId) => {
            try {
              await api.updateTag(moveTarget.id, { parent_id: parentId == null ? -1 : parentId })
              onTagsChanged?.()
            } catch (e) { alert('移动失败: ' + e.message) }
            finally { setMoveTarget(null) }
          }}
          onClose={() => setMoveTarget(null)}
        />
      )}
      {exportTarget && (
        <TagExportDialog tag={exportTarget}
          onClose={() => setExportTarget(null)}
          onDone={() => onTagsChanged?.()}
        />
      )}
    </div>
  )
}
