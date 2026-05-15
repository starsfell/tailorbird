import React, { useMemo } from 'react'
import { Tile } from './Tile.jsx'

export function Clusters({ shots, selected, setSelected, onOpen }) {
  const groups = useMemo(() => {
    const m = new Map()
    for (const s of shots) {
      if (s.cluster_id == null) continue
      if (!m.has(s.cluster_id)) m.set(s.cluster_id, [])
      m.get(s.cluster_id).push(s)
    }
    const out = []
    for (const [cid, arr] of m.entries()) {
      if (arr.length > 1) {
        arr.sort((a, b) => (b.subject_sharpness || 0) - (a.subject_sharpness || 0))
        out.push({ cid, shots: arr })
      }
    }
    return out
  }, [shots])

  const onToggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const selectNonBest = (group) => {
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

  if (groups.length === 0) {
    return <div className="empty">没有检测到多张连拍组。</div>
  }

  return (
    <div>
      <div style={{color:'var(--muted)', fontSize:12, marginBottom:8}}>
        共 {groups.length} 组连拍。每组绿框为推荐保留(清晰度最高),其余建议删除。双击图片放大看眼睛。
      </div>
      {groups.map(g => (
        <div key={g.cid} style={{marginBottom:12}}>
          <div className="cluster-head">
            <span>组 #{g.cid} · {g.shots.length} 张</span>
            <button onClick={() => selectGroupAll(g)} title="选中本组全部">全选本组</button>
            <button onClick={() => selectNonBest(g)}>选中本组非最佳</button>
          </div>
          <div className="cluster-row">
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
