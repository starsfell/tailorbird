import React, { useState } from 'react'
import { IconFolder, IconImage } from './Icons.jsx'

function fmtTime(ts) {
  if (!ts) return '未扫描'
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n) => String(n).padStart(2, '0')
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtSize(bytes) {
  if (!bytes) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes, i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function HomeView({ folders, busy, onPickFolder, onPickFiles, onOpenTask, onDeleteFolder, onToggleFolderComplete }) {
  const [runAi, setRunAi] = useState(false)
  return (
    <div className="home">
      <div className="home-hero">
        <h1 className="home-logo">Tailorbird ｜ 捡鸟</h1>
        <div className="home-actions">
          <button className="home-card" onClick={() => onPickFolder(runAi)} disabled={busy}>
            <div className="home-card-icon"><IconFolder size={32} /></div>
            <div className="home-card-title">选择文件夹</div>
            <div className="home-card-sub">扫描整个文件夹里的照片</div>
          </button>
          <button className="home-card" onClick={() => onPickFiles(runAi)} disabled={busy}>
            <div className="home-card-icon"><IconImage size={32} /></div>
            <div className="home-card-title">选择文件</div>
            <div className="home-card-sub">只挑选其中一部分照片</div>
          </button>
        </div>
        <label className="home-ai-toggle" title="关闭后只抽预览图和 EXIF,跳过鸟类识别/眼部清晰度/美学评分,几万张照片会快很多;之后随时可以对已导入的文件夹「重跑 AI」补上">
          <input type="checkbox" checked={runAi} onChange={e => setRunAi(e.target.checked)} disabled={busy} />
          导入时进行 AI 分析(鸟类识别/评分,量大会较慢)
        </label>
        {busy && <div className="home-busy">正在扫描，请稍候…</div>}
      </div>

      <div className="home-history">
        <h2>最近的挑片任务</h2>
        {(!folders || folders.length === 0) ? (
          <div className="home-empty">还没有任务。选择上方的文件夹或文件即可开始。</div>
        ) : (
          <div className="home-task-grid">
            {folders.map(f => (
              <div
                key={f.id}
                className="home-task"
                onClick={() => onOpenTask(f.path)}
                title={f.path}
              >
                <div className="home-task-head">
                  <div className="home-task-name">{f.path.replace(/^.*\//, '')}</div>
                  <div className="home-task-controls">
                    <button
                      className={'home-task-done' + (f.completed_at ? ' done' : '')}
                      title={f.completed_at ? '点击改回「待捡图」' : '点击标记为「已完成」'}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleFolderComplete?.(f.id, !f.completed_at)
                      }}
                    >{f.completed_at ? '已完成' : '待捡图'}</button>
                    <button
                      className="home-task-del"
                      title="从 tailorbird 移除此任务(不删磁盘文件)"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`从历史中移除「${f.path.replace(/^.*\//, '')}」?\n(只是移除记录,不会删除磁盘上的照片)`)) {
                          onDeleteFolder?.(f.id)
                        }
                      }}
                    >✕</button>
                  </div>
                </div>
                <div className="home-task-meta">
                  {(f.alive_count ?? f.photo_count ?? 0)} 张 · {fmtSize(f.alive_size)} · {fmtTime(f.last_scanned_at)}
                </div>
                <div className="home-task-path">{f.path}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
