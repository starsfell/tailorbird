import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { buildTagTree, descendantIds, tagPath } from './tagTree.js'
import { TagPickerDialog } from './TagPickerDialog.jsx'
import { TagExportDialog } from './TagExportDialog.jsx'

const PRESET_COLORS = [
  null, '#e85a5a', '#f29b3a', '#ffd866', '#4dd0a0', '#5a78ff', '#b88cff', '#ff6fa3',
]

function TagContextMenu({ tag, anchor, allTags, onClose, onChanged, onDeleted, onCreateChild, onMove, onExport, onQuickMove }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(tag.name)
  const [creating, setCreating] = useState(false)
  const [childName, setChildName] = useState('')
  const inputRef = useRef(null)
  useEffect(() => {
    if (renaming || creating) setTimeout(() => inputRef.current?.focus(), 30)
  }, [renaming, creating])

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
    const n = name.trim()
    if (!n || n === tag.name) { setRenaming(false); return }
    try { await api.updateTag(tag.id, { name: n }); onChanged?.(); onClose() }
    catch (e) { alert('改名失败: ' + e.message) }
  }
  const setColor = async (c) => { await api.updateTag(tag.id, { color: c }); onChanged?.(); onClose() }
  const toggleFav = async () => { await api.updateTag(tag.id, { is_favorite: !tag.is_favorite }); onChanged?.(); onClose() }
  const doDelete = async (mode) => {
    const labels = { lift: '保留子标签(升到父级)', orphan: '保留子标签(变根节点)', cascade: '同时删除所有子标签' }
    const ok = window.confirm(`删除标签「${tag.name}」?\n  · ${labels[mode]}\n  · 会从 ${tag.usage_count} 张直接引用此 tag 的照片移除`)
    if (!ok) return
    await api.deleteTag(tag.id, mode)
    onDeleted?.(); onClose()
  }
  const doCreateChild = async () => {
    const n = childName.trim()
    if (!n) { setCreating(false); return }
    await api.createTag(n, { parent_id: tag.id })
    onChanged?.(); onClose()
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
          <input ref={inputRef} type="text" value={childName}
            placeholder="子标签名"
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

function TagTreeRow({
  node, depth, byId,
  expandedIds, toggleExpand,
  selectedIds, onToggle,
  countsByTag, searchTerm, onContext,
}) {
  const hasChildren = node.children.length > 0
  const expanded = expandedIds.has(node.id) || !!searchTerm
  const active = selectedIds.has(node.id)
  const directCount = countsByTag?.get(node.id)
  return (
    <>
      <div className={'tag-row' + (active ? ' active' : '')}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onToggle(node.id)}
        onContextMenu={(e) => { e.preventDefault(); onContext(node, { x: e.clientX, y: e.clientY }) }}
      >
        <span className="name" style={{ minWidth: 0 }}>
          <span
            className="caret"
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggleExpand(node.id) }}
            style={{
              width: 12, display:'inline-block', textAlign:'center',
              cursor: hasChildren ? 'pointer' : 'default', color:'var(--muted)',
              userSelect:'none',
            }}
          >{hasChildren ? (expanded ? '▾' : '▸') : ''}</span>
          <span className="swatch" style={node.color ? { background: node.color } : undefined} />
          <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}
            title={tagPath(byId, node.id).join(' / ')}>
            {node.name}
            {node.is_favorite ? <span style={{color:'#ffd866', marginLeft:4}}>★</span> : null}
          </span>
        </span>
        <span className="count">
          {countsByTag && countsByTag.size > 0 && directCount != null
            ? `${directCount}/${node.usage_count}`
            : node.usage_count}
        </span>
        <button className="more" title="管理 (右键)"
          onClick={(e) => { e.stopPropagation(); onContext(node, { x: e.clientX, y: e.clientY }) }}>⋯</button>
      </div>
      {hasChildren && expanded && node.children.map(c => (
        <TagTreeRow key={c.id} node={c} depth={depth + 1} byId={byId}
          expandedIds={expandedIds} toggleExpand={toggleExpand}
          selectedIds={selectedIds} onToggle={onToggle}
          countsByTag={countsByTag} searchTerm={searchTerm} onContext={onContext}
        />
      ))}
    </>
  )
}

// Prune the tree to only nodes matching `term` or having a descendant that does.
function pruneTree(roots, term) {
  if (!term) return roots
  const lower = term.toLowerCase()
  const visit = (n) => {
    const kept = n.children.map(visit).filter(Boolean)
    const selfMatch = n.name.toLowerCase().includes(lower)
    if (selfMatch || kept.length > 0) return { ...n, children: kept }
    return null
  }
  return roots.map(visit).filter(Boolean)
}

// Virtual status filters — computed from shot row fields, not real DB tags.
// id is the wire format the App's refreshShots understands.
const STATUS_GROUPS = [
  {
    title: '星级',
    items: [
      { id: 'star-3', label: '★★★ 三星' },
      { id: 'star-2', label: '★★ 二星' },
      { id: 'star-1', label: '★ 一星' },
      { id: 'star-0', label: '☆ 无星' },
      { id: 'no-bird', label: '无鸟' },
    ],
  },
  {
    title: '状态',
    items: [
      { id: 'pick', label: '精修 P' },
      { id: 'focus-best', label: '精焦' },
      { id: 'focus-off', label: '脱焦' },
      { id: 'flying', label: '飞版' },
      { id: 'over', label: '过曝' },
      { id: 'under', label: '欠曝' },
    ],
  },
]

function StatusFilterSection({ statusFilter, setStatusFilter, statusCounts }) {
  const toggle = (id) => setStatusFilter(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  return (
    <>
      {STATUS_GROUPS.map(g => (
        <React.Fragment key={g.title}>
          <div className="section-title">{g.title}</div>
          {g.items.map(item => {
            const active = statusFilter.has(item.id)
            const count = statusCounts?.[item.id]
            return (
              <div key={item.id}
                className={'tag-row status-row' + (active ? ' active' : '')}
                onClick={() => toggle(item.id)}
                style={{ paddingLeft: 18 }}
                title="点击切换筛选"
              >
                <span className="name">
                  <span className={'cmp-pick' + (active ? ' on' : '')} style={{minWidth:14,display:'inline-block',textAlign:'center'}}>
                    {active ? '✓' : ''}
                  </span>
                  <span style={{marginLeft:4}}>{item.label}</span>
                </span>
                {count != null && <span className="count">{count}</span>}
              </div>
            )
          })}
        </React.Fragment>
      ))}
    </>
  )
}

export function TagFilterPanel({
  expanded, setExpanded,
  allTags, tagFilter, setTagFilter,
  filterMode, setFilterMode,
  negate, setNegate,
  onTagsChanged,
  countsByTag,
  viewCount,
  onSelectAllInView,
  statusFilter, setStatusFilter, statusCounts,
}) {
  const [q, setQ] = useState('')
  const [ctx, setCtx] = useState(null)
  const [moveTarget, setMoveTarget] = useState(null) // tag being moved
  const [exportTarget, setExportTarget] = useState(null) // tag being exported
  const [expandedIds, setExpandedIds] = useState(() => {
    try {
      const raw = localStorage.getItem('tagTreeExpanded')
      return new Set(raw ? JSON.parse(raw) : [])
    } catch { return new Set() }
  })
  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      try { localStorage.setItem('tagTreeExpanded', JSON.stringify([...next])) } catch {}
      return next
    })
  }

  // One-time seed: auto-expand 拍摄参数 + its 4 direct children (ISO, 镜头, 焦距, 光圈)
  // so users see all auto-generated shooting-param tags at first glance.
  useEffect(() => {
    if (allTags.length === 0) return
    try {
      if (localStorage.getItem('tagTreeAutoSeeded') === '1') return
    } catch { return }
    const root = allTags.find(t => t.name === '拍摄参数')
    if (!root) return
    const toExpand = new Set([root.id])
    for (const t of allTags) if (t.parent_id === root.id) toExpand.add(t.id)
    setExpandedIds(prev => {
      const next = new Set([...prev, ...toExpand])
      try {
        localStorage.setItem('tagTreeExpanded', JSON.stringify([...next]))
        localStorage.setItem('tagTreeAutoSeeded', '1')
      } catch {}
      return next
    })
  }, [allTags])

  const { roots, byId } = useMemo(() => buildTagTree(allTags), [allTags])
  const pruned = useMemo(() => pruneTree(roots, q.trim()), [roots, q])

  const isFav = (n) => n.is_favorite
  const favRoots = pruned.filter(isFav)
  const nonFavRoots = pruned.filter(n => !isFav(n))

  const toggle = (id) => {
    setTagFilter(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  if (!expanded) {
    return (
      <aside className="tag-panel collapsed">
        <button className="panel-toggle" onClick={() => setExpanded(true)} title="展开标签面板">
          <span>标签</span>
          {tagFilter.size > 0 && <span style={{color:'var(--accent)'}}>● {tagFilter.size}</span>}
        </button>
      </aside>
    )
  }

  const renderTree = (nodes) => nodes.map(n => (
    <TagTreeRow key={n.id} node={n} depth={0} byId={byId}
      expandedIds={expandedIds} toggleExpand={toggleExpand}
      selectedIds={tagFilter} onToggle={toggle}
      countsByTag={countsByTag} searchTerm={q.trim()}
      onContext={(tag, anchor) => setCtx({ tag, anchor })}
    />
  ))

  return (
    <aside className="tag-panel expanded">
      <div className="panel-head">
        <h3>标签</h3>
        <button onClick={() => setExpanded(false)} title="收起">›</button>
      </div>
      <div className="panel-body">
        <input className="panel-search" placeholder="搜索…" value={q}
          onChange={(e) => setQ(e.target.value)} />
        <div className="panel-mode">
          <button className={filterMode === 'or' ? 'active' : ''} onClick={() => setFilterMode('or')} title="任一命中">任一</button>
          <button className={filterMode === 'and' ? 'active' : ''} onClick={() => setFilterMode('and')} title="全部命中">全部</button>
          <button
            className={'negate' + (negate ? ' active' : '')}
            onClick={() => setNegate?.(!negate)}
            disabled={tagFilter.size === 0}
            title={tagFilter.size === 0
              ? '先选一个或多个标签,再点排除会反过来:只显示不含这些标签的 shot'
              : (negate ? '当前在排除模式:点击切回正常显示' : '排除:只显示不含已选标签的 shot(把已打标的隐藏)')}
          >{negate ? '✓ 排除' : '排除'}</button>
        </div>
        {onSelectAllInView && (
          <div className="panel-actions">
            <button
              onClick={onSelectAllInView}
              disabled={!viewCount}
              title="选中当前筛后所有 shot"
            >全选 {viewCount ? `(${viewCount})` : ''}</button>
          </div>
        )}
        {tagFilter.size > 0 && (
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', margin:'6px 0'}}>
            <span style={{fontSize:11, color:'var(--muted)'}}>已选 {tagFilter.size}</span>
            <button onClick={() => setTagFilter(new Set())} style={{padding:'2px 6px', fontSize:11}}>清空</button>
          </div>
        )}
        {setStatusFilter && (
          <StatusFilterSection
            statusFilter={statusFilter || new Set()}
            setStatusFilter={setStatusFilter}
            statusCounts={statusCounts}
          />
        )}
        {favRoots.length > 0 && (
          <>
            <div className="section-title">常用</div>
            {renderTree(favRoots)}
          </>
        )}
        {nonFavRoots.length > 0 && (
          <>
            {favRoots.length > 0 && <div className="section-title">全部</div>}
            {renderTree(nonFavRoots)}
          </>
        )}
        {pruned.length === 0 && (
          <div style={{color:'var(--muted)', fontSize:12, padding:'10px 0'}}>
            {allTags.length === 0 ? '暂无标签 — 选中后按 T 创建' : '无匹配'}
          </div>
        )}
      </div>
      {ctx && (
        <TagContextMenu tag={ctx.tag} anchor={ctx.anchor} allTags={allTags}
          onClose={() => setCtx(null)}
          onChanged={onTagsChanged}
          onCreateChild={() => {}}
          onMove={(tag) => { setCtx(null); setMoveTarget(tag) }}
          onExport={(tag) => { setCtx(null); setExportTarget(tag) }}
          onQuickMove={async (tag) => {
            setCtx(null)
            const ok = window.confirm(`把所有打了「${tag.name}」(含子标签)的照片移到各自源目录下的 ${tag.name}/ 子文件夹? (ARW+HIF 配对)`)
            if (!ok) return
            try {
              const r = await api.moveTagToSubfolder(tag.id)
              onTagsChanged?.()
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
      {exportTarget && (
        <TagExportDialog tag={exportTarget}
          onClose={() => setExportTarget(null)}
          onDone={() => onTagsChanged?.()}
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
            } catch (e) {
              alert('移动失败: ' + e.message)
            } finally {
              setMoveTarget(null)
            }
          }}
          onClose={() => setMoveTarget(null)}
        />
      )}
    </aside>
  )
}
