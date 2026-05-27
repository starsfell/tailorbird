import React, { useMemo, useRef } from 'react'
import { Tile } from './Tile.jsx'

export function Grid({ shots, selected, setSelected, onOpen }) {
  // Group shots by cluster_id for visual separation; within each cluster sort by sharpness desc.
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
        arr.sort((a, b) => (b.subject_sharpness || 0) - (a.subject_sharpness || 0))
        return { cid, shots: arr, earliest: Math.min(...arr.map(s => s.shot_at || Infinity)) }
      })
      .sort((a, b) => a.earliest - b.earliest)
    if (orphans.length) sorted.push({ cid: null, shots: orphans, earliest: Infinity })
    return sorted
  }, [shots])

  // Flat display order across all groups — Shift+click selects the range in this order.
  const flatIds = useMemo(() => groups.flatMap(g => g.shots.map(s => s.primary_id)), [groups])

  const anchorIdRef = useRef(null)

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
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
