import React, { useEffect, useState } from 'react'
import { api } from './api.js'
import { Tile } from './Tile.jsx'

// Visually-similar groups across the entire folder, ignoring time. Useful for
// catching "same scene shot twice with a gap in between" that burst clustering
// would miss.
export function SimilarView({ folder, selected, setSelected, onOpen, refreshTick = 0 }) {
  const [groups, setGroups] = useState([])
  const [threshold, setThreshold] = useState(24)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!folder) return
    setLoading(true); setError(null)
    const ctrl = new AbortController()
    api.similarGroups(folder, threshold)
      .then(r => { if (!ctrl.signal.aborted) setGroups(r.groups) })
      .catch(e => { if (!ctrl.signal.aborted) setError(e.message) })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [folder, threshold, refreshTick])

  const onToggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const selectGroupExceptBest = (g) => {
    setSelected(prev => {
      const next = new Set(prev)
      const best = g.shots[0]   // already sorted by eye/subj desc
      for (const s of g.shots) if (s.primary_id !== best.primary_id) next.add(s.primary_id)
      return next
    })
  }

  return (
    <div>
      <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:10}}>
        <span style={{fontSize:12, color:'var(--muted)'}}>
          相似度阈值
        </span>
        <input
          type="range" min="8" max="64" step="2" value={threshold}
          onChange={e => setThreshold(Number(e.target.value))}
          style={{width:240}}
        />
        <span style={{fontSize:12, fontVariantNumeric:'tabular-nums', minWidth:28, textAlign:'right'}}>{threshold}</span>
        <span style={{fontSize:11, color:'var(--muted)'}}>
          (越小越严:16≈几乎一样,24≈同场景,32≈类似场景,48≈大类相似)
        </span>
        <div style={{flex:1}} />
        <span style={{fontSize:12, color:'var(--muted)'}}>
          {loading ? '计算中…' : `${groups.length} 组,共 ${groups.reduce((a,g)=>a+g.size,0)} 张`}
        </span>
      </div>
      {error && <div style={{color:'var(--warn)', fontSize:12}}>错误: {error}</div>}
      {!loading && groups.length === 0 && !error && (
        <div className="empty">没有找到相似图片组(可尝试调高阈值)</div>
      )}
      {groups.map((g, idx) => (
        <div key={idx} className="cluster-block" style={{marginBottom:12}}>
          <div className="cluster-head">
            <span>相似组 #{idx + 1} · {g.size} 张</span>
            <button onClick={() => selectGroupExceptBest(g)}>选中本组非最佳</button>
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
