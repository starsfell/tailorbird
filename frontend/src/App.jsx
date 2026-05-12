import React, { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { Grid } from './Grid.jsx'
import { Clusters } from './Clusters.jsx'
import { DetailView } from './DetailView.jsx'
import { Compare } from './Compare.jsx'
import { SimilarView } from './SimilarView.jsx'

const PHASE_LABEL = {
  idle: '空闲',
  scanning: '扫描目录…',
  analyzing: '抽预览/算清晰度',
  clustering: '聚类连拍',
  ai_analyzing: 'AI 分析',
  done: '完成',
  error: '出错',
}

export default function App() {
  const [folder, setFolder] = useState('')
  const [tab, setTab] = useState('grid')
  const [scanStatus, setScanStatus] = useState(null)
  const [shots, setShots] = useState([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState(new Set())
  const [filter, setFilter] = useState({ min_sharpness: 0, only_cluster_best: false, min_stars: 0, only_pick: false })
  const [category, setCategory] = useState(null)   // 'no-bird' | 'oof' | 'over' | 'under' | 'zero' | 'flying' | 'best-focus' | null
  const [busy, setBusy] = useState(false)
  const [pairDelete, setPairDelete] = useState(true)
  const [deleteMode, setDeleteMode] = useState('move')  // 'trash' | 'move' (move is safer)
  const [subfolderName, setSubfolderName] = useState('ToReview')
  const [preset, setPreset] = useState('intermediate')
  const [folders, setFolders] = useState([])
  const [detail, setDetail] = useState(null)
  const [compare, setCompare] = useState(null)
  const [similarTick, setSimilarTick] = useState(0)   // bump to force SimilarView re-fetch

  const refreshFolders = useCallback(async () => {
    try {
      const { folders } = await api.listFolders()
      setFolders(folders || [])
      if (!folder && folders?.length) setFolder(folders[0].path)
    } catch (e) { console.error(e) }
  }, [folder])

  const refreshShots = useCallback(async () => {
    if (!folder) return
    try {
      const r = await api.listShots({ folder, min_sharpness: filter.min_sharpness, only_cluster_best: filter.only_cluster_best, limit: 5000, include_deleted: false })
      let items = r.items
      if (filter.min_stars > 0) items = items.filter(s => (s.rating ?? -1) >= filter.min_stars)
      if (filter.only_pick) items = items.filter(s => s.pick)
      if (category === 'no-bird') items = items.filter(s => s.rating === -1)
      else if (category === 'oof') items = items.filter(s => s.focus_weight != null && s.focus_weight < 0.7)
      else if (category === 'over') items = items.filter(s => s.is_over)
      else if (category === 'under') items = items.filter(s => s.is_under)
      else if (category === 'zero') items = items.filter(s => s.rating === 0)
      else if (category === 'flying') items = items.filter(s => s.is_flying)
      else if (category === 'best-focus') items = items.filter(s => s.focus_weight != null && s.focus_weight >= 1.05)
      setShots(items)
      setTotal(r.total)
    } catch (e) { console.error(e) }
  }, [folder, filter, category])

  useEffect(() => { refreshFolders() }, [refreshFolders])
  useEffect(() => { refreshShots() }, [refreshShots])

  // Continuous poll of scan status — works regardless of who started the run
  useEffect(() => {
    let cancelled = false
    let lastPhase = null
    const tick = async () => {
      try {
        const s = await api.scanStatus()
        if (cancelled) return
        setScanStatus(s)
        if (lastPhase && lastPhase !== 'done' && lastPhase !== 'error' && s.phase === 'done') {
          refreshShots()
        }
        lastPhase = s.phase
      } catch (e) {}
      if (!cancelled) setTimeout(tick, 1000)
    }
    tick()
    return () => { cancelled = true }
  }, [refreshShots])

  const onScan = async () => {
    if (!folder.trim()) return
    setBusy(true)
    try { await api.startScan(folder.trim(), true) }
    catch (e) { alert('扫描启动失败: ' + e.message); setBusy(false); return }
    const wait = () => new Promise(r => setTimeout(r, 1500))
    while (true) {
      await wait()
      try {
        const s = await api.scanStatus()
        if (s.phase === 'done' || s.phase === 'error') break
      } catch (e) { break }
    }
    setBusy(false); await refreshShots(); await refreshFolders()
  }

  const onRerunAi = async () => {
    setBusy(true)
    try { await api.recompute(folder, true, preset) }
    catch (e) { alert('AI 启动失败: ' + e.message); setBusy(false); return }
    while (true) {
      await new Promise(r => setTimeout(r, 1500))
      const s = await api.scanStatus()
      if (s.phase === 'done' || s.phase === 'error') break
    }
    setBusy(false); await refreshShots()
  }

  const onApplyPreset = async (p) => {
    setPreset(p)
    try {
      await api.applyPreset(folder, p)
      await refreshShots()
    } catch (e) { alert('预设应用失败: ' + e.message) }
  }

  const onDelete = async (overrideIds) => {
    const ids = overrideIds ? Array.from(overrideIds) : Array.from(selected)
    if (ids.length === 0) return
    const verb = deleteMode === 'move' ? `移到 "${subfolderName}" 子文件夹` : '送入废纸篓'
    const ok = window.confirm(`将 ${ids.length} 张${verb}${pairDelete ? '(含 ARW/HIF 配对)' : ''}?`)
    if (!ok) return
    try {
      const r = await api.deletePhotos(ids, pairDelete, deleteMode, subfolderName)
      setSelected(prev => { const next = new Set(prev); ids.forEach(i => next.delete(i)); return next })
      await refreshShots()
      setSimilarTick(t => t + 1)
      const failed = r.failed?.length || 0
      if (failed) alert(`完成,${failed} 失败`)
    } catch (e) { alert('删除失败: ' + e.message) }
  }

  const onWriteXmp = async () => {
    const ids = selected.size > 0
      ? Array.from(selected)
      : shots.filter(s => s.rating != null && s.rating >= 0).map(s => s.primary_id)
    if (ids.length === 0) return alert('没有可写的对象')
    const ok = window.confirm(`将 ${ids.length} 张的星级/Pick/Label 写回 XMP(原文件)?`)
    if (!ok) return
    try {
      const r = await api.writeXmp(ids)
      alert(`已写入 ${r.updated.length} 个,失败 ${r.failed.length}`)
    } catch (e) { alert('写 EXIF 失败: ' + e.message) }
  }

  const openDetail = (shot) => {
    const i = Math.max(0, shots.findIndex(s => s.primary_id === shot.primary_id))
    setDetail({ list: shots, index: i })
  }

  const openCompare = () => {
    const list = shots.filter(s => selected.has(s.primary_id))
    if (list.length < 2) { alert('请至少选 2 张'); return }
    if (list.length > 9) { alert('最多 9 张同时对比'); return }
    setCompare(list)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (detail || compare) return
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); setSelected(new Set(shots.map(s => s.primary_id))) }
      else if (e.key === 'Escape') { setSelected(new Set()) }
      else if (e.key === 'b' || e.key === 'B') {
        const ids = shots.filter(s => s.cluster_id != null && !s.is_cluster_best).map(s => s.primary_id)
        setSelected(new Set(ids))
      }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); onDelete() }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); openCompare() }
      else if (e.key === ' ') {
        e.preventDefault()
        const first = shots.find(s => selected.has(s.primary_id))
        if (first) openDetail(first)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shots, selected, detail, compare])

  const statusText = scanStatus
    ? `${PHASE_LABEL[scanStatus.phase] || scanStatus.phase}${scanStatus.total ? ` ${scanStatus.done}/${scanStatus.total}` : ''}`
    : ''

  const handleDetailDelete = async (shot) => {
    await onDelete([shot.primary_id])
    setDetail(prev => {
      if (!prev) return null
      const newList = prev.list.filter(s => s.primary_id !== shot.primary_id)
      return newList.length === 0 ? null : { list: newList, index: Math.min(prev.index, newList.length - 1) }
    })
  }
  const handleCompareDelete = async (shot) => {
    await onDelete([shot.primary_id])
    setCompare(prev => prev ? prev.filter(s => s.primary_id !== shot.primary_id) : null)
  }

  return (
    <div className="app">
      <div className="topbar">
        <input
          type="text" value={folder} onChange={e => setFolder(e.target.value)}
          placeholder="照片目录绝对路径"
        />
        <button className="primary" onClick={onScan} disabled={busy || !folder.trim()}>{busy ? '处理中…' : '扫描+AI'}</button>
        <button onClick={onRerunAi} disabled={busy || !folder} title="只重跑 AI,不重新扫描">重跑 AI</button>
        <div className="status">{statusText}</div>
        <div className="tabs">
          <button className={tab === 'grid' ? 'active' : ''} onClick={() => setTab('grid')}>网格</button>
          <button className={tab === 'cluster' ? 'active' : ''} onClick={() => setTab('cluster')}>连拍组</button>
          <button className={tab === 'similar' ? 'active' : ''} onClick={() => setTab('similar')}>相似图片</button>
        </div>
      </div>

      <div className="body">
        <aside className="sidebar">
          <h3>已扫描目录</h3>
          {folders.length === 0 && <div style={{color:'var(--muted)', fontSize:12}}>暂无</div>}
          {folders.map(f => (
            <div key={f.id} style={{
              padding:'6px 8px', borderRadius:6, marginBottom:4,
              background: f.path === folder ? '#1f2228' : 'transparent',
              cursor:'pointer', fontSize:12, wordBreak:'break-all',
            }} onClick={() => setFolder(f.path)} title={f.path}>
              {f.path.replace(/^.*\//, '')}
              <div style={{color:'var(--muted)', fontSize:11}}>{f.alive_count}/{f.photo_count} 文件</div>
            </div>
          ))}

          <h3 style={{marginTop:20}}>水平预设</h3>
          <div className="row">
            <select value={preset} onChange={e => onApplyPreset(e.target.value)}>
              <option value="beginner">新手 (宽松)</option>
              <option value="intermediate">初级 (平衡)</option>
              <option value="master">大师 (严格)</option>
            </select>
          </div>

          <h3 style={{marginTop:20}}>快速分类</h3>
          <div className="chips">
            {[
              ['全部', null],
              ['无鸟', 'no-bird'],
              ['0★', 'zero'],
              ['脱焦', 'oof'],
              ['精焦', 'best-focus'],
              ['过曝', 'over'],
              ['欠曝', 'under'],
              ['飞鸟', 'flying'],
            ].map(([label, val]) => (
              <button
                key={label}
                className={`chip${category === val ? ' active' : ''}`}
                onClick={() => setCategory(val)}
              >
                {label}
              </button>
            ))}
          </div>

          <h3 style={{marginTop:20}}>筛选</h3>
          <div className="row">
            <label>最低星级</label>
            <select value={filter.min_stars} onChange={e => setFilter(f => ({...f, min_stars: Number(e.target.value)}))}>
              <option value="0">全部</option>
              <option value="1">≥ 1★</option>
              <option value="2">≥ 2★</option>
              <option value="3">3★</option>
            </select>
          </div>
          <div className="row">
            <input type="checkbox" id="pickonly" checked={filter.only_pick}
              onChange={e => setFilter(f => ({...f, only_pick: e.target.checked}))} />
            <label htmlFor="pickonly">只看 Pick</label>
          </div>
          <div className="row">
            <input type="checkbox" id="best" checked={filter.only_cluster_best}
              onChange={e => setFilter(f => ({...f, only_cluster_best: e.target.checked}))} />
            <label htmlFor="best">只看每组最佳</label>
          </div>

          <h3 style={{marginTop:20}}>删除方式</h3>
          <div className="row">
            <select value={deleteMode} onChange={e => setDeleteMode(e.target.value)}>
              <option value="move">移到子文件夹</option>
              <option value="trash">送系统废纸篓</option>
            </select>
          </div>
          {deleteMode === 'move' && (
            <>
              <div className="row">
                <label style={{flexShrink:0}}>子文件夹</label>
                <input type="text" value={subfolderName} style={{flex:1, minWidth:0}}
                  onChange={e => setSubfolderName(e.target.value)} />
              </div>
              <div className="row">
                <button
                  style={{width:'100%'}}
                  disabled={!folder || !subfolderName.trim()}
                  onClick={async () => {
                    try {
                      const { matches } = await api.findMoveTarget(folder, subfolderName.trim())
                      if (!matches || matches.length === 0) {
                        alert(`还没有移动过文件到「${subfolderName}」`)
                        return
                      }
                      // Prefer the one with files; fall back to most-recently-modified.
                      const withFiles = matches.filter(m => m.file_count > 0)
                      const pick = (withFiles[0] || matches[0]).path
                      await api.openFolder(pick)
                    } catch (e) { alert('打开失败: ' + e.message) }
                  }}
                  title="在 Finder 中打开该子文件夹"
                >
                  在 Finder 中打开
                </button>
              </div>
            </>
          )}
          <div className="row">
            <input type="checkbox" id="pair" checked={pairDelete}
              onChange={e => setPairDelete(e.target.checked)} />
            <label htmlFor="pair">成对处理 ARW/HIF</label>
          </div>

          <h3 style={{marginTop:20}}>EXIF 写回</h3>
          <button onClick={onWriteXmp} style={{width:'100%'}}>
            写星级到原文件
          </button>
          <div style={{fontSize:10, color:'var(--muted)', marginTop:4}}>
            Lightroom 等可读取
          </div>

          <h3 style={{marginTop:20}}>快捷键</h3>
          <div style={{fontSize:11, color:'var(--muted)', lineHeight:1.7}}>
            单击 选 · 双击/Space 放大<br/>
            A 全选 · Esc 清空<br/>
            B 选所有非组内最佳<br/>
            C 对比 · D 删除
          </div>
        </aside>

        <main className="main">
          {tab === 'similar' ? (
            folder
              ? <SimilarView folder={folder} selected={selected} setSelected={setSelected} onOpen={openDetail} refreshTick={similarTick} />
              : <div className="empty">请先选一个目录</div>
          ) : shots.length === 0 ? (
            <div className="empty">{folder ? '没有照片。点击扫描开始。' : '请输入照片目录路径并扫描。'}</div>
          ) : tab === 'grid' ? (
            <Grid shots={shots} selected={selected} setSelected={setSelected} onOpen={openDetail} />
          ) : (
            <Clusters shots={shots} selected={selected} setSelected={setSelected} onOpen={openDetail} />
          )}
        </main>
      </div>

      <div className="footer">
        <div>共 {total} shot{shots.length !== total ? `,筛后 ${shots.length}` : ''}</div>
        <div>已选 {selected.size}</div>
        <div className="spacer" />
        <button onClick={openCompare} disabled={selected.size < 2}>对比 (C)</button>
        <button onClick={() => setSelected(new Set())} disabled={selected.size === 0}>清空</button>
        <button className="danger" disabled={selected.size === 0} onClick={() => onDelete()}>
          {deleteMode === 'move' ? `移走 (${selected.size})` : `废纸篓 (${selected.size})`}
        </button>
      </div>

      {detail && <DetailView shots={detail.list} startIndex={detail.index} onClose={() => setDetail(null)} onDelete={handleDetailDelete} onRefresh={refreshShots} />}
      {compare && <Compare shots={compare} onClose={() => setCompare(null)} onDelete={handleCompareDelete} />}
    </div>
  )
}
