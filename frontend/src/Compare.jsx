import React, { useState, useEffect, useCallback } from 'react'
import { api } from './api.js'
import { PanZoom } from './PanZoom.jsx'
import { TagQuickBar } from './TagQuickBar.jsx'

const ZOOM_DEFAULT = 5.0  // 500%
const COMPARE_SOURCE_PX = 6400
const REFINE_TAG = '精修'   // 与 App.jsx 一致:批量"精修"标签名
const KEEP_TAG = '保留'     // 与 App.jsx 一致:批量"保留"标签名

// Side-by-side comparison with linked pan/zoom by default.
//
// All photos use a single shared {scale, offsetX, offsetY}. Each photo's
// transform = -scale * base * (anchor - 0.5) + offset, where `anchor` is the
// photo's logical center-of-interest:
//   - eye_xy (AI eye keypoint) if detected
//   - bird_bbox center if a bird was detected but no eye
//   - image center (0.5, 0.5) otherwise
// This means every bird's interest point sits at the same screen position; pan
// or zoom any photo and all others follow.
//
// S (or the button) disables linkage entirely; in that mode each photo is on
// its own (still fit-to-cell initially).
export function Compare({ shots, onClose, onDelete, onRemove, onBatchDelete, onBatchRemove, allTags, onTagsApplied }) {
  const [linked, setLinked] = useState(true)
  const [shared, setShared] = useState({ scale: ZOOM_DEFAULT, offsetX: 0, offsetY: 0 })
  const [bases, setBases] = useState({})
  const [indepT, setIndepT] = useState({})
  const [pickedIds, setPickedIds] = useState(new Set())
  const togglePick = (id) => setPickedIds(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })
  const pickableShots = shots.filter(s => !s.isStackResult)
  const pickAll = () => setPickedIds(new Set(pickableShots.map(s => s.primary_id)))
  const invertPick = () => setPickedIds(prev => new Set(
    pickableShots.map(s => s.primary_id).filter(id => !prev.has(id))
  ))
  const clearPick = () => setPickedIds(new Set())
  const pickedShots = shots.filter(s => pickedIds.has(s.primary_id))

  const anchorFor = (s) => {
    if (Array.isArray(s.eye_xy) && s.eye_xy.length === 2) return s.eye_xy
    if (Array.isArray(s.bird_bbox) && s.bird_bbox.length === 4) {
      const [x, y, w, h] = s.bird_bbox
      return [x + w / 2, y + h / 2]
    }
    return [0.5, 0.5]
  }

  const transformForShot = useCallback((s) => {
    const base = bases[s.primary_id]
    if (!base || !base.w) return undefined
    if (!linked) {
      return indepT[s.primary_id] || { scale: 1, x: 0, y: 0 }
    }
    const [ax, ay] = anchorFor(s)
    return {
      scale: shared.scale,
      x: -shared.scale * base.w * (ax - 0.5) + shared.offsetX,
      y: -shared.scale * base.h * (ay - 0.5) + shared.offsetY,
    }
  }, [bases, shared, linked, indepT])

  const reportFromShot = useCallback((s, newT) => {
    if (!linked) {
      setIndepT(prev => ({ ...prev, [s.primary_id]: newT }))
      return
    }
    const base = bases[s.primary_id]
    if (!base) return
    const [ax, ay] = anchorFor(s)
    const anchorX = -newT.scale * base.w * (ax - 0.5)
    const anchorY = -newT.scale * base.h * (ay - 0.5)
    setShared({
      scale: newT.scale,
      offsetX: newT.x - anchorX,
      offsetY: newT.y - anchorY,
    })
  }, [bases, linked])

  const handleBase = useCallback((s, b) => {
    setBases(prev => ({ ...prev, [s.primary_id]: b }))
  }, [])

  const resetView = () => {
    setShared({ scale: ZOOM_DEFAULT, offsetX: 0, offsetY: 0 })
    setIndepT({})
  }

  const hasTag = (s, name) => (s.tags || []).some(t => t.name === name)

  // 切换某标签:remove=true 取消,否则添加(后端不存在时自动建)。堆栈结果跳过。
  const toggleTag = async (tagName, targetShots, remove) => {
    const ids = targetShots.filter(s => !s.isStackResult).map(s => s.primary_id)
    if (ids.length === 0) return
    try {
      if (remove) {
        const tag = (allTags || []).find(t => t.name === tagName)
        if (!tag) return
        await api.batchPhotoTags(ids, { remove_tag_ids: [tag.id] })
      } else {
        await api.batchPhotoTags(ids, { add_tag_names: [tagName] })
      }
      onTagsApplied?.()
    } catch (e) { alert('标签操作失败: ' + e.message) }
  }

  // 是否"全部已带该标签" → 决定按钮是"取消"(实心)还是"添加"(空心)。
  const allPickedRefined = pickedShots.length > 0 && pickedShots.every(s => hasTag(s, REFINE_TAG))
  const allPickableRefined = pickableShots.length > 0 && pickableShots.every(s => hasTag(s, REFINE_TAG))
  const allPickedKept = pickedShots.length > 0 && pickedShots.every(s => hasTag(s, KEEP_TAG))
  const allPickableKept = pickableShots.length > 0 && pickableShots.every(s => hasTag(s, KEEP_TAG))

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      // 左手键(A/D/S/R)与右手键(L/J/K/U)双套并行。
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') {
        if (pickedIds.size > 0) clearPick()
        else onClose()
      }
      else if (k === 's' || k === 'k') setLinked(v => !v)   // 联动
      else if (e.key === '0') resetView()
      else if (k === 'r' || k === 'u') {   // Finder
        // Reveal the first picked, else the first non-stack compared shot.
        const target = pickedShots[0] || pickableShots[0]
        if (target) {
          e.preventDefault()
          const p = target.isStackResult
            ? api.revealPath(target.resultPath)
            : api.revealInFinder(target.primary_id)
          p.catch(err => alert('打开 Finder 失败: ' + err.message))
        }
      }
      else if (k === 'a' || k === 'o') { e.preventDefault(); pickAll() }   // 全选
      else if (k === 'p') {   // 全选删除 = 删除全部对比中的图
        if (pickableShots.length > 0) { e.preventDefault(); onBatchDelete?.(pickableShots) }
      }
      else if (k === 'd' || k === 'j') {   // 删选
        if (pickedShots.length > 0) {
          e.preventDefault()
          onBatchDelete?.(pickedShots)
          clearPick()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, shots, pickedIds])

  const n = shots.length
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3

  return (
    <div className="modal compare-modal">
      <div className="modal-header">
        <div>
          <div style={{fontSize:13}}>
            对比 {n} 张 · {linked ? '联动 (500% 对鸟眼/鸟身/中心)' : '独立操作'}
          </div>
          <div style={{fontSize:11, color:'var(--muted)', marginTop:2}}>
            点格子标题栏加入多选(图片区不受影响,可自由拖动) · 全选 A/O · 删选 D/J · 删除全部 P · Finder R/U · 联动 S/K · 0 重置 · Esc 关闭
          </div>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          {pickedIds.size > 0 ? (
            <>
              <span style={{fontSize:12, color:'var(--accent)'}}>已选 {pickedIds.size}</span>
              <button onClick={pickAll} title="全选 (A / O)">全选</button>
              <button onClick={invertPick}>反选</button>
              <button onClick={clearPick} title="清空选择 (Esc)">清空</button>
              <button onClick={() => { onBatchRemove?.(pickedShots); clearPick() }}
                title="把选中从对比里移出,不删文件">移出对比 ({pickedIds.size})</button>
              <button className={allPickedRefined ? 'success' : 'success-outline'}
                onClick={() => toggleTag(REFINE_TAG, pickedShots, allPickedRefined)}
                title={allPickedRefined ? '取消选中照片的「精修」标签' : '给选中的照片加「精修」标签'}>
                {allPickedRefined ? `取消精修 (${pickedIds.size})` : `精修 (${pickedIds.size})`}
              </button>
              <button className={allPickedKept ? 'keep' : 'keep-outline'}
                onClick={() => toggleTag(KEEP_TAG, pickedShots, allPickedKept)}
                title={allPickedKept ? '取消选中照片的「保留」标签' : '给选中的照片加「保留」标签'}>
                {allPickedKept ? `取消保留 (${pickedIds.size})` : `保留 (${pickedIds.size})`}
              </button>
              <button className="danger" onClick={() => { onBatchDelete?.(pickedShots); clearPick() }}
                title="按当前删除模式删选中 (D / J)">{`删除 (${pickedIds.size})`}</button>
            </>
          ) : (
            <>
              <button onClick={pickAll} title="全选所有对比中的图 (A / O)">A 全选</button>
              <button className={allPickableRefined ? 'success' : 'success-outline'}
                onClick={() => toggleTag(REFINE_TAG, pickableShots, allPickableRefined)}
                title={allPickableRefined ? '取消全部对比照片的「精修」标签' : '给全部对比中的照片加「精修」标签'}>
                {allPickableRefined ? '取消精修全部' : '精修全部'}
              </button>
              <button className={allPickableKept ? 'keep' : 'keep-outline'}
                onClick={() => toggleTag(KEEP_TAG, pickableShots, allPickableKept)}
                title={allPickableKept ? '取消全部对比照片的「保留」标签' : '给全部对比中的照片加「保留」标签'}>
                {allPickableKept ? '取消保留全部' : '保留全部'}
              </button>
              <button className="danger" onClick={() => onBatchDelete?.(pickableShots)}
                title="按当前删除模式删除所有对比中的图 (P)">{`删除全部 (${pickableShots.length})`}</button>
            </>
          )}
          <button onClick={resetView}>0 重置</button>
          <button onClick={() => setLinked(v => !v)}>{linked ? '解除联动' : '开启联动'}</button>
          <button onClick={onClose}>Esc 关闭</button>
        </div>
      </div>
      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {shots.map(s => {
          const eye = s.eye_sharpness == null ? null : s.eye_sharpness.toFixed(2)
          const subj = s.subject_sharpness == null ? '—' : s.subject_sharpness.toFixed(2)
          const stars = s.rating == null || s.rating < 0
            ? '— 无鸟 —'
            : ('★'.repeat(s.rating) + '☆'.repeat(3 - s.rating))
          return (
            <div
              key={s.primary_id}
              className={'compare-cell' + (pickedIds.has(s.primary_id) ? ' picked' : '')}
            >
              <div
                className="compare-cell-head"
                onClick={(e) => {
                  if (e.target.closest('button')) return
                  if (e.nativeEvent.detail !== 1) return
                  if (s.isStackResult) return  // can't pick the synthetic stack result
                  togglePick(s.primary_id)
                }}
                title={s.isStackResult ? '堆栈结果(只展示,不参与多选)' : '点击此条加入多选'}
                style={{cursor: s.isStackResult ? 'default' : 'pointer'}}
              >
                <span style={{display:'flex', alignItems:'center', gap:6}}>
                  {s.isStackResult ? (
                    <span className="badge" style={{background:'var(--accent)', color:'#000'}}>STACK</span>
                  ) : (
                    <span className={'cmp-pick' + (pickedIds.has(s.primary_id) ? ' on' : '')}>
                      {pickedIds.has(s.primary_id) ? '✓' : ''}
                    </span>
                  )}
                  {!s.isStackResult && <span style={{color:'#ffd866'}}>{stars}</span>}
                  <span>{s.stem}</span>
                  {s.pick && <span className="badge pick-flag">P</span>}
                  {s.focus_weight != null && s.focus_weight >= 1.05 && <span className="badge focus-best">精焦</span>}
                </span>
                <span style={{color:'var(--muted)', fontVariantNumeric:'tabular-nums'}}>
                  {s.isStackResult ? '' : (eye ? `眼${eye}` : `主${subj}`)}
                </span>
                <span style={{display:'flex', gap:6, alignItems:'center'}}>
                  {!s.isStackResult && (
                    <>
                      <button
                        className={'refine-dot' + (hasTag(s, REFINE_TAG) ? ' on' : '')}
                        onClick={(e) => { e.stopPropagation(); toggleTag(REFINE_TAG, [s], hasTag(s, REFINE_TAG)) }}
                        title={hasTag(s, REFINE_TAG) ? '已精修 · 点击取消' : '标记为精修'}
                      >精</button>
                      <button
                        className={'keep-dot' + (hasTag(s, KEEP_TAG) ? ' on' : '')}
                        onClick={(e) => { e.stopPropagation(); toggleTag(KEEP_TAG, [s], hasTag(s, KEEP_TAG)) }}
                        title={hasTag(s, KEEP_TAG) ? '已保留 · 点击取消' : '标记为保留'}
                      >保</button>
                    </>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const p = s.isStackResult
                        ? api.revealPath(s.resultPath)
                        : api.revealInFinder(s.primary_id)
                      p.catch(err => alert(err.message))
                    }}
                    style={{padding:'2px 8px'}}
                    title="在 Finder 中显示 (R / U)"
                  >📁</button>
                  {!s.isStackResult && (
                    <>
                      <button onClick={() => onRemove?.(s)} style={{padding:'2px 8px'}} title="从对比中移出(不删文件)">移出对比</button>
                      <button onClick={() => onDelete?.(s)} className="danger" style={{padding:'2px 8px'}}>删</button>
                    </>
                  )}
                </span>
              </div>
              <PanZoom
                src={s.imageUrl ?? api.fullUrl(s.primary_id, COMPARE_SOURCE_PX)}
                onBaseChange={(b) => handleBase(s, b)}
                transform={transformForShot(s)}
                onTransform={(nt) => reportFromShot(s, nt)}
              />
            </div>
          )
        })}
      </div>
      {pickedShots.length > 0 && (
        <TagQuickBar
          shots={pickedShots}
          allTags={allTags || []}
          onApplied={onTagsApplied}
          onClose={clearPick}
        />
      )}
    </div>
  )
}
