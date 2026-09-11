import React, { useMemo, useRef, useState } from 'react'
import { Tile } from './Tile.jsx'

const SORT_MODES = [
  { key: 'stem', label: '编号' },
  { key: 'score_desc', label: '分数 ↓' },
  { key: 'score_asc', label: '分数 ↑' },
]

function sortShots(arr, sortMode) {
  const byStem = (a, b) => (a.stem || '').localeCompare(b.stem || '', undefined, { numeric: true })
  if (sortMode === 'score_desc') {
    arr.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || byStem(a, b))
  } else if (sortMode === 'score_asc') {
    arr.sort((a, b) => (a.rating ?? -1) - (b.rating ?? -1) || byStem(a, b))
  } else {
    arr.sort(byStem)
  }
  return arr
}

export function Grid({ shots, selected, setSelected, onOpen }) {
  // Order within each cluster: by filename (stem, default), or by score asc/desc.
  const [sortMode, setSortMode] = useState('stem')

  // Search-by-stem locate: typing jumps to the first match and highlights it;
  // Enter (Shift+Enter for reverse) cycles through the rest.
  const [query, setQuery] = useState('')
  const [highlightId, setHighlightId] = useState(null)
  const matchIdxRef = useRef(-1)
  const highlightTimerRef = useRef(null)

  // Group shots by cluster_id for visual separation.
  const groups = useMemo(() => {
    const buckets = new Map()
    const orphans = []
    for (const s of shots) {
      if (s.cluster_id == null) {
        orphans.push(s); continue
      }
      const arr = buckets.get(s.cluster_id) || []
      arr.push(s)
      buckets.set(s.cluster_id, arr)
    }
    const sorted = Array.from(buckets.entries())
      .map(([cid, arr]) => {
        sortShots(arr, sortMode)
        return { cid, shots: arr, earliest: Math.min(...arr.map(s => s.shot_at || Infinity)) }
      })
      .sort((a, b) => a.earliest - b.earliest)
    if (orphans.length) sorted.push({ cid: null, shots: sortShots(orphans, sortMode), earliest: Infinity })
    return sorted
  }, [shots, sortMode])

  // Flat display order across all groups — Shift+click selects the range in this order.
  const flatIds = useMemo(() => groups.flatMap(g => g.shots.map(s => s.primary_id)), [groups])
  const flatShots = useMemo(() => groups.flatMap(g => g.shots), [groups])

  const anchorIdRef = useRef(null)

  const findMatches = (q) => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return flatShots.filter(sh => (sh.stem || '').toLowerCase().includes(s))
  }

  const highlightShot = (shot) => {
    if (!shot) return
    const el = document.getElementById(`tile-${shot.primary_id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(shot.primary_id)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightId(null), 1400)
  }

  const handleQueryChange = (val) => {
    setQuery(val)
    const m = findMatches(val)
    matchIdxRef.current = m.length ? 0 : -1
    if (m.length) highlightShot(m[0])
  }

  const handleQueryKeyDown = (e) => {
    if (e.key === 'Escape') { setQuery(''); return }
    if (e.key !== 'Enter') return
    const m = findMatches(query)
    if (!m.length) return
    e.preventDefault()
    matchIdxRef.current = (matchIdxRef.current + (e.shiftKey ? -1 : 1) + m.length) % m.length
    highlightShot(m[matchIdxRef.current])
  }

  const matchCount = useMemo(() => findMatches(query).length, [flatShots, query])

  const handleTileClick = (id, e) => {
    if (e?.shiftKey && anchorIdRef.current != null && anchorIdRef.current !== id) {
      const a = flatIds.indexOf(anchorIdRef.current)
      const b = flatIds.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(prev => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(flatIds[i])
          return next
        })
        // Clear browser text selection that Shift+click may have created.
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

  const selectGroupNonBest = (group) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const s of group.shots) if (!s.is_cluster_best) next.add(s.primary_id)
      return next
    })
  }

  const selectGroupAll = (group) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const s of group.shots) next.add(s.primary_id)
      return next
    })
  }

  return (
    <div className="grid-grouped">
      <div className="grid-sort-bar chips">
        <span style={{color:'var(--muted)', fontSize:11}}>组内排序:</span>
        {SORT_MODES.map(m => (
          <button
            key={m.key}
            className={'chip' + (sortMode === m.key ? ' active' : '')}
            onClick={() => setSortMode(m.key)}
          >
            {m.label}
          </button>
        ))}
        <span className="grid-search">
          <input
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={handleQueryKeyDown}
            placeholder="搜索编号定位… (Enter 下一个)"
          />
          {query.trim() && (
            <span className="grid-search-count">
              {matchCount > 0 ? `${matchIdxRef.current + 1}/${matchCount}` : '无匹配'}
            </span>
          )}
        </span>
      </div>
      {groups.map(g => (
        <div key={g.cid ?? 'orphan'} className="cluster-block">
          <div className="cluster-head">
            <span>
              {g.cid == null
                ? `单张 · ${g.shots.length} 张`
                : `组 #${g.cid} · ${g.shots.length} 张${g.shots.length > 1 ? '(连拍)' : ''}`}
            </span>
            {g.shots.length > 1 && (
              <>
                <button onClick={() => selectGroupAll(g)} title="选中本组全部">全选本组</button>
                <button onClick={() => selectGroupNonBest(g)}>选中本组非最佳</button>
              </>
            )}
          </div>
          <div className="grid">
            {g.shots.map(s => (
              <Tile
                key={s.primary_id}
                shot={s}
                selected={selected.has(s.primary_id)}
                onToggle={handleTileClick}
                onOpen={onOpen}
                highlighted={highlightId === s.primary_id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
