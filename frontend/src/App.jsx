import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { Grid } from './Grid.jsx'
import { Clusters } from './Clusters.jsx'
import { DetailView } from './DetailView.jsx'
import { Compare } from './Compare.jsx'
import { SimilarView } from './SimilarView.jsx'
import { TagBatchDialog } from './TagBatchDialog.jsx'
import { TagFilterPanel } from './TagFilterPanel.jsx'
import { ExifPanel } from './ExifPanel.jsx'
import { TagCenterView } from './TagCenterView.jsx'
import { TriageView } from './TriageView.jsx'
import { StackDialog } from './StackDialog.jsx'
import { HomeView } from './HomeView.jsx'

const PHASE_LABEL = {
  idle: '空闲',
  scanning: '扫描目录…',
  analyzing: '抽预览/算清晰度',
  clustering: '聚类连拍',
  ai_analyzing: 'AI 分析',
  done: '完成',
  cancelled: '已停止',
  error: '出错',
}

export default function App() {
  const [view, setView] = useState('home')   // 'home' 引导首页 | 'workspace' 挑片工作区
  const scanningRef = useRef(false)   // 新任务扫描进行中: 网格清空只显示进度,不显示残留数据
  const [folder, setFolder] = useState('')
  const [pickedFiles, setPickedFiles] = useState([])   // 用"选文件"挑出的文件子集
  const [openMenuOpen, setOpenMenuOpen] = useState(false)   // "打开 ▾" 下拉是否展开
  const [subsetStems, setSubsetStems] = useState(new Set())   // 子集扫描后只看刚扫描的这些 stem;空=看整目录
  const [tab, setTab] = useState('grid')
  const [scanStatus, setScanStatus] = useState(null)
  const [shots, setShots] = useState([])
  const [shotsBeforeTagFilter, setShotsBeforeTagFilter] = useState([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState(new Set())
  const [filter, setFilter] = useState({ min_sharpness: 0, only_cluster_best: false, min_stars: 0, only_pick: false })
  const [category, setCategory] = useState(null)   // 'no-bird' | 'oof' | 'over' | 'under' | 'zero' | 'flying' | 'best-focus' | null
  const [tagFilter, setTagFilter] = useState(new Set())   // Set<tag_id>
  const [tagFilterMode, setTagFilterMode] = useState('or')   // 'or' | 'and'
  const [tagFilterNegate, setTagFilterNegate] = useState(false)  // 开启后:显示"不含这些标签"的 shot
  const [allTags, setAllTags] = useState([])
  const [tagsTick, setTagsTick] = useState(0)
  const [tagPanelExpanded, setTagPanelExpanded] = useState(() => {
    try { return localStorage.getItem('tagPanelExpanded') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('tagPanelExpanded', tagPanelExpanded ? '1' : '0') } catch {}
  }, [tagPanelExpanded])
  const [exifPanelExpanded, setExifPanelExpanded] = useState(() => {
    try { return localStorage.getItem('exifPanelExpanded') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('exifPanelExpanded', exifPanelExpanded ? '1' : '0') } catch {}
  }, [exifPanelExpanded])
  const [statusFilter, setStatusFilter] = useState(new Set())   // Set<string> of STATUS_GROUPS ids
  const [statusCounts, setStatusCounts] = useState({})            // {[id]: number}
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('sortBy') || 'shot_at' } catch { return 'shot_at' }
  })
  const [sortOrder, setSortOrder] = useState(() => {
    try { return localStorage.getItem('sortOrder') || 'asc' } catch { return 'asc' }
  })
  useEffect(() => { try { localStorage.setItem('sortBy', sortBy) } catch {} }, [sortBy])
  useEffect(() => { try { localStorage.setItem('sortOrder', sortOrder) } catch {} }, [sortOrder])
  const [busy, setBusy] = useState(false)
  const [pairDelete, setPairDelete] = useState(true)
  const [deleteMode, setDeleteMode] = useState('move')  // 'trash' | 'move' (move is safer)
  const [subfolderName, setSubfolderName] = useState('ToReview')
  const [preset, setPreset] = useState('intermediate')
  const [folders, setFolders] = useState([])
  const [detail, setDetail] = useState(null)
  const [compare, setCompare] = useState(null)
  const [similarTick, setSimilarTick] = useState(0)   // bump to force SimilarView re-fetch
  const [tagDialogIds, setTagDialogIds] = useState(null)  // Set<id> | null
  const [stackDialogOpen, setStackDialogOpen] = useState(false)

  const refreshFolders = useCallback(async () => {
    try {
      const { folders } = await api.listFolders()
      setFolders(folders || [])
      if (!folder && folders?.length) setFolder(folders[0].path)
    } catch (e) { console.error(e) }
  }, [folder])

  const refreshShots = useCallback(async () => {
    if (!folder) return
    // 新任务扫描进行中: 保持网格空白,只让顶栏显示进度,避免误导成"已有结果"
    if (scanningRef.current) { setShots([]); setShotsBeforeTagFilter([]); setTotal(0); return }
    try {
      const r = await api.listShots({ folder, min_sharpness: filter.min_sharpness, only_cluster_best: filter.only_cluster_best, sort_by: sortBy, sort_order: sortOrder, limit: 5000, include_deleted: false })
      let items = r.items
      // 子集视图: 只保留刚用"选文件"扫描的那几张(按 stem 匹配)
      if (subsetStems.size > 0) items = items.filter(s => subsetStems.has(s.stem))
      const datasetTotal = subsetStems.size > 0 ? items.length : r.total
      if (filter.min_stars > 0) items = items.filter(s => (s.rating ?? -1) >= filter.min_stars)
      if (filter.only_pick) items = items.filter(s => s.pick)
      if (category === 'no-bird') items = items.filter(s => s.rating === -1)
      else if (category === 'oof') items = items.filter(s => s.focus_weight != null && s.focus_weight < 0.7)
      else if (category === 'over') items = items.filter(s => s.is_over)
      else if (category === 'under') items = items.filter(s => s.is_under)
      else if (category === 'zero') items = items.filter(s => s.rating === 0)
      else if (category === 'flying') items = items.filter(s => s.is_flying)
      else if (category === 'best-focus') items = items.filter(s => s.focus_weight != null && s.focus_weight >= 1.05)
      // Counts shown next to status rows are computed BEFORE statusFilter is
      // applied, so toggling one doesn't zero out the others.
      const counts = { 'star-3':0,'star-2':0,'star-1':0,'star-0':0,'no-bird':0,
                       pick:0, 'focus-best':0, 'focus-off':0, flying:0, over:0, under:0 }
      for (const s of items) {
        if (s.rating === 3) counts['star-3']++
        else if (s.rating === 2) counts['star-2']++
        else if (s.rating === 1) counts['star-1']++
        else if (s.rating === 0) counts['star-0']++
        else if (s.rating === -1) counts['no-bird']++
        if (s.pick) counts.pick++
        if (s.focus_weight != null && s.focus_weight >= 1.05) counts['focus-best']++
        if (s.focus_weight != null && s.focus_weight < 0.8) counts['focus-off']++
        if (s.is_flying) counts.flying++
        if (s.is_over) counts.over++
        if (s.is_under) counts.under++
      }
      setStatusCounts(counts)
      // Status virtual filters (OR within set — any selected status matches)
      if (statusFilter.size > 0) {
        items = items.filter(s => {
          for (const id of statusFilter) {
            if (id === 'star-3' && s.rating === 3) return true
            if (id === 'star-2' && s.rating === 2) return true
            if (id === 'star-1' && s.rating === 1) return true
            if (id === 'star-0' && s.rating === 0) return true
            if (id === 'no-bird' && s.rating === -1) return true
            if (id === 'pick' && s.pick) return true
            if (id === 'focus-best' && s.focus_weight != null && s.focus_weight >= 1.05) return true
            if (id === 'focus-off' && s.focus_weight != null && s.focus_weight < 0.8) return true
            if (id === 'flying' && s.is_flying) return true
            if (id === 'over' && s.is_over) return true
            if (id === 'under' && s.is_under) return true
          }
          return false
        })
      }
      setShotsBeforeTagFilter(items)
      if (tagFilter.size > 0) {
        const matchAnd = (s) => {
          const ids = new Set((s.tags || []).map(t => t.id))
          for (const id of tagFilter) if (!ids.has(id)) return false
          return true
        }
        const matchOr = (s) => (s.tags || []).some(t => tagFilter.has(t.id))
        const match = tagFilterMode === 'and' ? matchAnd : matchOr
        items = items.filter(s => tagFilterNegate ? !match(s) : match(s))
      }
      setShots(items)
      setTotal(datasetTotal)
    } catch (e) { console.error(e) }
  }, [folder, filter, category, tagFilter, tagFilterMode, tagFilterNegate, statusFilter, sortBy, sortOrder, subsetStems])

  useEffect(() => { refreshFolders() }, [refreshFolders])
  useEffect(() => { refreshShots() }, [refreshShots])
  useEffect(() => {
    api.listTags().then(r => setAllTags(r.tags || [])).catch(() => {})
  }, [tagsTick])

  const countsByTag = useMemo(() => {
    const m = new Map()
    for (const s of shots) for (const t of (s.tags || [])) m.set(t.id, (m.get(t.id) || 0) + 1)
    return m
  }, [shots])

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

  const stemOf = (p) => (p.split('/').pop() || '').replace(/\.[^.]+$/, '')

  // 开始一次新扫描前: 清空网格 + 进入"扫描中"状态, 这样工作区只显示进度不显示残留
  const beginFreshScan = () => {
    scanningRef.current = true
    setSubsetStems(new Set()); setSelected(new Set())
    setShots([]); setShotsBeforeTagFilter([]); setTotal(0)
  }

  const onScan = async (runAi = true, folderArg = null) => {
    const target = (folderArg ?? folder).trim()
    if (!target) return
    beginFreshScan()
    setBusy(true)
    try { await api.startScan(target, runAi) }
    catch (e) { scanningRef.current = false; alert('扫描启动失败: ' + e.message); setBusy(false); return }
    const wait = () => new Promise(r => setTimeout(r, 1500))
    while (true) {
      await wait()
      try {
        const s = await api.scanStatus()
        if (s.phase === 'done' || s.phase === 'error' || s.phase === 'cancelled') break
      } catch (e) { break }
    }
    scanningRef.current = false
    setBusy(false); await refreshShots(); await refreshFolders()
  }

  const onScanFiles = async (runAi = true, filesArg = null) => {
    const files = filesArg ?? pickedFiles
    if (!files.length) return
    beginFreshScan()
    setBusy(true)
    try { await api.startScanFiles(files, runAi) }
    catch (e) { scanningRef.current = false; alert('扫描启动失败: ' + e.message); setBusy(false); return }
    let phase = 'error'
    while (true) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        const s = await api.scanStatus()
        phase = s.phase
        if (s.phase === 'done' || s.phase === 'error' || s.phase === 'cancelled') break
      } catch (e) { break }
    }
    scanningRef.current = false
    if (phase === 'done') {
      // 扫描成功: 清空已选, 切到"只看刚扫描的这几张"子集视图
      const stems = new Set(files.map(stemOf))
      setPickedFiles([])
      setSubsetStems(stems)   // 触发 refreshShots(经依赖变化), 故不在此手动刷新 shots
      setBusy(false); await refreshFolders()
      return
    }
    // 失败/取消: 保留已选以便重试
    setBusy(false); await refreshShots(); await refreshFolders()
  }

  // ── 首页(引导页)入口 ───────────────────────────────────────────────
  // 新建任务 = 选文件夹/文件 → 进入工作区并开始扫描; 历史 = 直接打开已扫描目录
  const onHomePickFolder = async () => {
    let r
    try { r = await api.pickFolder() } catch (e) { alert('打开选择框失败: ' + e.message); return }
    if (!r.path) return
    setFolder(r.path); setPickedFiles([]); setSubsetStems(new Set()); setView('workspace')
    const known = folders.some(f => f.path === r.path)
    if (!known) await onScan(true, r.path)   // 新文件夹才扫描; 已扫过的直接打开
  }

  const onHomePickFiles = async () => {
    let r
    try { r = await api.pickFiles() } catch (e) { alert('打开选择框失败: ' + e.message); return }
    if (!r.files || !r.files.length) return
    setPickedFiles(r.files)
    if (r.folder) setFolder(r.folder)
    setView('workspace')
    await onScanFiles(true, r.files)
  }

  const onOpenTask = (path) => { setFolder(path); setPickedFiles([]); setSubsetStems(new Set()); setView('workspace') }

  const onCancelScan = async () => {
    try { await api.cancelScan() } catch (e) { /* 扫描可能刚好结束,忽略 */ }
  }

  const onPickFolder = async () => {
    try {
      const r = await api.pickFolder()
      if (r.path) { setFolder(r.path); setPickedFiles([]); setSubsetStems(new Set()) }
    } catch (e) { alert('打开选择框失败: ' + e.message) }
  }

  const onPickFiles = async () => {
    try {
      const r = await api.pickFiles()
      if (r.files && r.files.length) {
        setPickedFiles(r.files)
        if (r.folder) setFolder(r.folder)   // 让"已扫描目录"等视图能对上父目录
      }
    } catch (e) { alert('打开选择框失败: ' + e.message) }
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

  // 返回 true = 文件已处理；false = 用户取消或失败。调用方据此决定是否更新本地 UI 状态。
  const onDelete = async (overrideIds) => {
    const ids = overrideIds ? Array.from(overrideIds) : Array.from(selected)
    if (ids.length === 0) return false
    const verb = deleteMode === 'move' ? `移到 "${subfolderName}" 子文件夹` : '送入废纸篓'
    const ok = window.confirm(`将 ${ids.length} 张${verb}${pairDelete ? '(含 ARW/HIF 配对)' : ''}?`)
    if (!ok) return false
    try {
      const r = await api.deletePhotos(ids, pairDelete, deleteMode, subfolderName)
      setSelected(prev => { const next = new Set(prev); ids.forEach(i => next.delete(i)); return next })
      await refreshShots()
      setSimilarTick(t => t + 1)
      const failed = r.failed?.length || 0
      if (failed) alert(`完成,${failed} 失败`)
      return true
    } catch (e) { alert('删除失败: ' + e.message); return false }
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
      if (tagDialogIds) {
        if (e.key === 'Escape') { e.preventDefault(); setTagDialogIds(null) }
        return
      }
      if (stackDialogOpen) return
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); setSelected(new Set(shots.map(s => s.primary_id))) }
      else if (e.key === 'Escape') { setSelected(new Set()) }
      else if (e.key === 'b' || e.key === 'B') {
        const ids = shots.filter(s => s.cluster_id != null && !s.is_cluster_best).map(s => s.primary_id)
        setSelected(new Set(ids))
      }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); onDelete() }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); openCompare() }
      else if (e.key === 't' || e.key === 'T') {
        if (selected.size > 0) { e.preventDefault(); setTagDialogIds(new Set(selected)) }
      }
      else if (e.key === 's' || e.key === 'S') {
        if (selected.size >= 2) { e.preventDefault(); setStackDialogOpen(true) }
      }
      else if (e.key === 'r' || e.key === 'R') {
        if (selected.size > 0) {
          e.preventDefault()
          const firstId = [...selected][0]
          api.revealInFinder(firstId).catch(err => alert('打开 Finder 失败: ' + err.message))
        }
      }
      else if (e.key === ' ') {
        e.preventDefault()
        const first = shots.find(s => selected.has(s.primary_id))
        if (first) openDetail(first)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shots, selected, detail, compare, tagDialogIds, stackDialogOpen])

  const statusText = scanStatus
    ? `${PHASE_LABEL[scanStatus.phase] || scanStatus.phase}${scanStatus.total ? ` ${scanStatus.done}/${scanStatus.total}` : ''}`
    : ''

  const handleDetailDelete = async (shot) => {
    const ok = await onDelete([shot.primary_id])
    if (!ok) return
    setDetail(prev => {
      if (!prev) return null
      const newList = prev.list.filter(s => s.primary_id !== shot.primary_id)
      return newList.length === 0 ? null : { list: newList, index: Math.min(prev.index, newList.length - 1) }
    })
  }
  const handleCompareDelete = async (shot) => {
    const ok = await onDelete([shot.primary_id])
    if (!ok) return
    setCompare(prev => prev ? prev.filter(s => s.primary_id !== shot.primary_id) : null)
  }

  const handleCompareRemove = (shot) => {
    setCompare(prev => {
      if (!prev) return null
      const next = prev.filter(s => s.primary_id !== shot.primary_id)
      return next.length < 2 ? null : next
    })
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(shot.primary_id)
      return next
    })
  }

  const handleCompareBatchDelete = async (shotList) => {
    const ids = shotList.map(s => s.primary_id)
    if (ids.length === 0) return
    const ok = await onDelete(ids)
    if (!ok) return
    setCompare(prev => prev ? prev.filter(s => !ids.includes(s.primary_id)) : null)
  }

  const handleCompareBatchRemove = (shotList) => {
    const idSet = new Set(shotList.map(s => s.primary_id))
    setCompare(prev => {
      if (!prev) return null
      const next = prev.filter(s => !idSet.has(s.primary_id))
      return next.length < 2 ? null : next
    })
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of idSet) next.delete(id)
      return next
    })
  }

  if (view === 'home') {
    return (
      <HomeView
        folders={folders}
        busy={busy}
        onPickFolder={onHomePickFolder}
        onPickFiles={onHomePickFiles}
        onOpenTask={onOpenTask}
        onDeleteFolder={async (id) => { await api.deleteFolder(id); await refreshFolders() }}
      />
    )
  }

  return (
    <div className="app">
      <div className="topbar">
        <button className="home-back" onClick={() => setView('home')} title="返回首页">← 首页</button>
        <input
          type="text" value={folder} onChange={e => setFolder(e.target.value)}
          placeholder="照片目录绝对路径"
        />
        <div className={`open-dropdown${openMenuOpen ? ' open' : ''}`}>
          <button className="open-trigger" onClick={() => setOpenMenuOpen(v => !v)} title="选择要扫描的文件或文件夹">
            打开 <span className="caret">▾</span>
          </button>
          {openMenuOpen && (
            <>
              <div className="open-menu-backdrop" onClick={() => setOpenMenuOpen(false)} />
              <div className="open-menu">
                <button onClick={() => { setOpenMenuOpen(false); onPickFolder() }}>打开文件夹…</button>
                <button onClick={() => { setOpenMenuOpen(false); onPickFiles() }}>打开文件…</button>
              </div>
            </>
          )}
        </div>
        {pickedFiles.length > 0 && (
          <span className="picked-files-badge" title={pickedFiles.slice(0, 20).join('\n') + (pickedFiles.length > 20 ? `\n… 共 ${pickedFiles.length} 个` : '')}>
            已选 {pickedFiles.length} 个文件
            <button className="picked-files-clear" onClick={() => setPickedFiles([])} title="清空已选文件,改回整目录扫描">✕</button>
          </span>
        )}
        {pickedFiles.length > 0 ? (
          <>
            <button className="primary" onClick={() => onScanFiles(true)} disabled={busy}>{busy ? '处理中…' : `扫描选中 ${pickedFiles.length} 张+AI`}</button>
            <button onClick={() => onScanFiles(false)} disabled={busy} title="只抽预览/EXIF,跳过 AI">快速扫描选中</button>
          </>
        ) : (
          <>
            <button className="primary" onClick={() => onScan(true)} disabled={busy || !folder.trim()}>{busy ? '处理中…' : '扫描+AI'}</button>
            <button onClick={() => onScan(false)} disabled={busy || !folder.trim()} title="只抽预览/EXIF,跳过 AI(适合非鸟摄,快很多)">快速扫描</button>
          </>
        )}
        {busy && (
          <button className="danger" onClick={onCancelScan} title="停止当前扫描(已分析的照片会保留)">停止</button>
        )}
        <button onClick={onRerunAi} disabled={busy || !folder} title="只重跑 AI,不重新扫描">重跑 AI</button>
        <div className="status">{statusText}</div>
        <div className="tabs">
          <button className={tab === 'grid' ? 'active' : ''} onClick={() => setTab('grid')}>网格</button>
          <button className={tab === 'cluster' ? 'active' : ''} onClick={() => setTab('cluster')}>连拍组</button>
          <button className={tab === 'similar' ? 'active' : ''} onClick={() => setTab('similar')}>相似图片</button>
          <button className={tab === 'triage' ? 'active' : ''} onClick={() => setTab('triage')}>整理</button>
          <button className={tab === 'tags' ? 'active' : ''} onClick={() => setTab('tags')}>标签</button>
        </div>
      </div>

      {subsetStems.size > 0 && (
        <div className="subset-banner">
          <span>只看刚扫描的 {subsetStems.size} 张</span>
          <button onClick={() => setSubsetStems(new Set())} title="显示该目录全部照片">显示整个目录</button>
        </div>
      )}

      <div className={`body${(tab === 'tags' || tab === 'triage') ? ' tag-mode' : ''}`}>
        {tab === 'tags' ? (
          <TagCenterView
            allTags={allTags}
            tagFilter={tagFilter}
            setTagFilter={setTagFilter}
            filterMode={tagFilterMode}
            setFilterMode={setTagFilterMode}
            onTagsChanged={() => setTagsTick(t => t + 1)}
            selected={selected}
            setSelected={setSelected}
            onOpen={openDetail}
          />
        ) : tab === 'triage' ? (
          <TriageView
            folder={folder}
            setFolder={setFolder}
            folders={folders}
            allTags={allTags}
            onTagsChanged={() => setTagsTick(t => t + 1)}
            selected={selected}
            setSelected={setSelected}
            onOpen={openDetail}
          />
        ) : (<>
        <aside className="sidebar">
          <h3>已扫描目录</h3>
          {folders.length === 0 && <div style={{color:'var(--muted)', fontSize:12}}>暂无</div>}
          {folders.map(f => (
            <div key={f.id} className="folder-row" style={{
              padding:'6px 8px', borderRadius:6, marginBottom:4,
              background: f.path === folder ? '#1f2228' : 'transparent',
              cursor:'pointer', fontSize:12, wordBreak:'break-all',
              position:'relative',
            }} onClick={() => { setFolder(f.path); setSubsetStems(new Set()) }} title={f.path}>
              <button
                className="folder-del"
                title="从 tailorbird 移除(不删磁盘文件)"
                onClick={async (e) => {
                  e.stopPropagation()
                  const name = f.path.replace(/^.*\//, '')
                  const ok = window.confirm(
                    `从 tailorbird 移除目录「${name}」?\n· 数据库里 ${f.photo_count} 张照片记录会清掉\n· 磁盘原文件不动`
                  )
                  if (!ok) return
                  try {
                    await api.deleteFolder(f.id)
                    if (folder === f.path) setFolder('')
                    await refreshFolders()
                    await refreshShots()
                  } catch (err) { alert('删除失败: ' + err.message) }
                }}
              >×</button>
              <div style={{paddingRight: 18}}>
                {f.path.replace(/^.*\//, '')}
                <div style={{color:'var(--muted)', fontSize:11}}>{f.alive_count}/{f.photo_count} 文件</div>
              </div>
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

          <h3 style={{marginTop:20}}>排序</h3>
          <div className="row">
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{flex:1}}>
              <option value="shot_at">拍摄时间</option>
              <option value="rating">星级</option>
              <option value="iso">ISO</option>
              <option value="f_number">光圈</option>
              <option value="focal_length">焦距</option>
              <option value="subject_sharpness">主体锐度</option>
              <option value="eye_sharpness">鸟眼锐度</option>
              <option value="aesthetic_score">美学</option>
              <option value="bird_confidence">鸟检置信</option>
            </select>
            <button onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
              title={sortOrder === 'asc' ? '升序(点切倒序)' : '降序(点切升序)'}
              style={{minWidth:36}}
            >{sortOrder === 'asc' ? '↑' : '↓'}</button>
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
              <div className="row">
                <button
                  className="danger"
                  style={{width:'100%'}}
                  disabled={!folder || !subfolderName.trim()}
                  onClick={async () => {
                    try {
                      const { matches } = await api.findMoveTarget(folder, subfolderName.trim())
                      const total = (matches || []).reduce((n, m) => n + (m.file_count || 0), 0)
                      if (total === 0) {
                        alert(`「${subfolderName}」里没有文件`)
                        return
                      }
                      const ok = window.confirm(
                        `把所有「${subfolderName}」子文件夹里的 ${total} 个文件送入废纸篓?\n` +
                        `(可在系统废纸篓里恢复)`
                      )
                      if (!ok) return
                      const r = await api.emptyMoveTarget(folder, subfolderName.trim())
                      const failed = r.failed?.length || 0
                      alert(`已移入废纸篓 ${r.trashed_count} 个文件` + (failed ? `,失败 ${failed} 个` : ''))
                    } catch (e) { alert('清空失败: ' + e.message) }
                  }}
                  title={`把所有 ${subfolderName}/ 里的文件送入系统废纸篓`}
                >
                  清空 {subfolderName} 到废纸篓
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
            <div className="empty">
              {busy
                ? `正在扫描…${statusText ? '  ' + statusText : ''}`
                : folder ? '没有照片。点击扫描开始。' : '请输入照片目录路径并扫描。'}
            </div>
          ) : tab === 'grid' ? (
            <Grid shots={shots} selected={selected} setSelected={setSelected} onOpen={openDetail} />
          ) : (
            <Clusters shots={shots} selected={selected} setSelected={setSelected} onOpen={openDetail} />
          )}
        </main>
        <div className="right-stack">
          <ExifPanel
            expanded={exifPanelExpanded}
            setExpanded={setExifPanelExpanded}
            focusedShot={detail ? detail.list[detail.index] : null}
            selectedShots={shots.filter(s => selected.has(s.primary_id))}
          />
          <TagFilterPanel
            expanded={tagPanelExpanded}
            setExpanded={setTagPanelExpanded}
            allTags={allTags}
            tagFilter={tagFilter}
            setTagFilter={setTagFilter}
            filterMode={tagFilterMode}
            setFilterMode={setTagFilterMode}
            negate={tagFilterNegate}
            setNegate={setTagFilterNegate}
            onTagsChanged={() => setTagsTick(t => t + 1)}
            countsByTag={countsByTag}
            viewCount={shots.length}
            onSelectAllInView={() => setSelected(new Set(shots.map(s => s.primary_id)))}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            statusCounts={statusCounts}
          />
        </div>
        </>)}
      </div>

      <div className="footer">
        <div>共 {total} shot{shots.length !== total ? `,筛后 ${shots.length}` : ''}</div>
        <div>已选 {selected.size}</div>
        <div className="spacer" />
        <button onClick={openCompare} disabled={selected.size < 2}>对比 (C)</button>
        <button onClick={() => setStackDialogOpen(true)} disabled={selected.size < 2}>堆栈 (S)</button>
        <button onClick={() => setTagDialogIds(new Set(selected))} disabled={selected.size === 0}>+ 标签 (T)</button>
        <button onClick={() => setSelected(new Set())} disabled={selected.size === 0}>清空</button>
        <button className="danger" disabled={selected.size === 0} onClick={() => onDelete()}>
          {deleteMode === 'move' ? `移走 (${selected.size})` : `废纸篓 (${selected.size})`}
        </button>
      </div>

      {detail && <DetailView shots={detail.list} startIndex={detail.index} onClose={() => setDetail(null)} onDelete={handleDetailDelete} onRefresh={async () => { await refreshShots(); setTagsTick(t => t + 1) }} />}
      {compare && <Compare
        shots={compare}
        onClose={() => { setCompare(null); setSelected(new Set()) }}
        onDelete={handleCompareDelete}
        onRemove={handleCompareRemove}
        onBatchDelete={handleCompareBatchDelete}
        onBatchRemove={handleCompareBatchRemove}
        allTags={allTags}
        onTagsApplied={async () => {
          await refreshShots()
          setTagsTick(t => t + 1)
          try {
            const r = await api.listShots({ folder, limit: 5000, include_deleted: false })
            const byId = new Map((r.items || []).map(s => [s.primary_id, s]))
            setCompare(prev => prev?.map(c => byId.get(c.primary_id) || c) || prev)
          } catch {}
        }}
      />}
      {tagDialogIds && (
        <TagBatchDialog
          shots={compare
            ? [...compare, ...shots.filter(s => !compare.some(c => c.primary_id === s.primary_id))]
            : shots}
          selectedIds={tagDialogIds}
          onClose={() => setTagDialogIds(null)}
          onApplied={async () => { await refreshShots(); setTagsTick(t => t + 1) }}
        />
      )}
      {stackDialogOpen && (
        <StackDialog
          shots={shots}
          selectedIds={selected}
          onClose={() => setStackDialogOpen(false)}
          onCompareSources={(stackShot, sourceIds) => {
            const sourceShots = shots.filter(s => sourceIds.has(s.primary_id))
            setStackDialogOpen(false)
            setCompare([stackShot, ...sourceShots])
          }}
        />
      )}
    </div>
  )
}
