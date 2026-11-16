import React, { useEffect, useRef, useState } from 'react'

export function useFolderSelection(folders) {
  const [selecting, setSelecting] = useState(false)
  const [ids, setIds] = useState(new Set())
  useEffect(() => {
    const available = new Set(folders.map(f => f.id))
    setIds(current => new Set([...current].filter(id => available.has(id))))
  }, [folders])
  const toggle = id => setIds(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const finish = () => { setSelecting(false); setIds(new Set()) }
  return { selecting, setSelecting, ids, setIds, toggle, finish }
}

export function FolderSelectionToolbar({ title, folders, selection, disabled, onManage, compact = false }) {
  const { selecting, setSelecting, ids, setIds, finish } = selection
  const allSelected = folders.length > 0 && ids.size === folders.length
  const allRef = useRef(null)
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = ids.size > 0 && !allSelected
  }, [ids, allSelected, selecting])
  const apply = async action => {
    const succeeded = await onManage([...ids], action)
    setIds(current => new Set([...current].filter(id => !succeeded.includes(id))))
  }
  return (
    <div className={'folder-manager' + (compact ? ' compact' : '')}>
      <div className="folder-manager-heading">
        {compact ? <h3>{title}</h3> : <h2>{title}</h2>}
        <button className="folder-select-toggle" disabled={disabled || (!selecting && !folders.length)}
          aria-pressed={selecting} onClick={() => selecting ? finish() : setSelecting(true)}>
          {selecting ? '退出多选' : '多选'}
        </button>
      </div>
      {selecting && (
        <div className="folder-selection-toolbar" role="group" aria-label="目录批量操作">
          <label className="folder-select-all">
            <input ref={allRef} type="checkbox" checked={allSelected} disabled={disabled}
              onChange={() => setIds(allSelected ? new Set() : new Set(folders.map(f => f.id)))} />
            全选
          </label>
          <span className="folder-selection-count" role="status">已选 {ids.size} 个</span>
          <div className="folder-batch-buttons">
            <button className="success-outline" disabled={disabled || !ids.size} onClick={() => apply('complete')}>标记已完成</button>
            <button disabled={disabled || !ids.size} onClick={() => apply('pending')}>改为待捡图</button>
            <button className="folder-delete-action" disabled={disabled || !ids.size} onClick={() => apply('delete')}>删除目录信息</button>
          </div>
        </div>
      )}
    </div>
  )
}
