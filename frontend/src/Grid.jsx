import React, { useMemo } from 'react'
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

  const onToggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const selectGroupNonBest = (group) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const s of group.shots) if (!s.is_cluster_best) next.add(s.primary_id)
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
              <button onClick={() => selectGroupNonBest(g)}>选中本组非最佳</button>
            )}
          </div>
          <div className="grid">
            {g.shots.map(s => (
              <Tile
                key={s.primary_id}
                shot={s}
                selected={selected.has(s.primary_id)}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
