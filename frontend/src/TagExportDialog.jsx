import React, { useEffect, useState } from 'react'
import { api } from './api.js'

const LS_KEY_BASE = 'tagExportBase'
const LS_KEY_MODE = 'tagExportMode'

export function TagExportDialog({ tag, onClose, onDone }) {
  const [base, setBase] = useState(() => {
    try { return localStorage.getItem(LS_KEY_BASE) || '' } catch { return '' }
  })
  const [subfolder, setSubfolder] = useState(tag?.name || '')
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(LS_KEY_MODE) || 'copy' } catch { return 'copy' }
  })
  const [pair, setPair] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const pickBase = async () => {
    try {
      const r = await api.pickFolder()
      if (r.path) setBase(r.path)
    } catch (e) { alert('打开选择框失败: ' + e.message) }
  }

  const go = async () => {
    if (!base.trim()) { alert('请先选择目标基目录'); return }
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await api.exportTag(tag.id, {
        dest_dir: base.trim(),
        subfolder_name: subfolder.trim() || tag.name,
        mode,
        pair_with_sidecar: pair,
      })
      try { localStorage.setItem(LS_KEY_BASE, base.trim()) } catch {}
      try { localStorage.setItem(LS_KEY_MODE, mode) } catch {}
      setResult(r)
      onDone?.()
    } catch (e) {
      setError(e.message || String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="dlg-overlay" onClick={() => !busy && onClose()}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{width: 520}}>
        <div className="dlg-head">
          <span>导出标签「{tag?.name}」到文件夹</span>
          <button onClick={onClose} disabled={busy}>Esc 关闭</button>
        </div>
        <div className="dlg-body">
          <div style={{fontSize:12, color:'var(--muted)', marginBottom:10}}>
            会汇集此标签 + 所有子标签下的照片(LR 风格祖先包含),配对 ARW+HIF,放到 <code>&lt;基目录&gt;/&lt;子文件夹&gt;/</code> 下。
          </div>

          <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto', gap:8, alignItems:'center', marginBottom:8}}>
            <span style={{color:'var(--muted)', fontSize:12}}>基目录</span>
            <input type="text" value={base} onChange={(e) => setBase(e.target.value)} placeholder="/Volumes/External/2026" style={{width:'100%'}} />
            <button onClick={pickBase} disabled={busy}>📁 选择…</button>

            <span style={{color:'var(--muted)', fontSize:12}}>子文件夹</span>
            <input type="text" value={subfolder} onChange={(e) => setSubfolder(e.target.value)} placeholder={tag?.name || ''} style={{width:'100%'}} />
            <span style={{fontSize:11, color:'var(--muted)'}}>默认 = 标签名</span>
          </div>

          <div style={{display:'flex', gap:14, alignItems:'center', marginBottom:8, fontSize:12}}>
            <label><input type="radio" name="mode" checked={mode === 'copy'} onChange={() => setMode('copy')} /> 复制(原文件保留)</label>
            <label><input type="radio" name="mode" checked={mode === 'move'} onChange={() => setMode('move')} /> 剪切(从 tailorbird 视图移走)</label>
          </div>
          <div style={{fontSize:12, marginBottom:14}}>
            <label><input type="checkbox" checked={pair} onChange={(e) => setPair(e.target.checked)} /> 同时带上同 stem 的 ARW/HIF</label>
          </div>

          {base.trim() && (
            <div style={{fontSize:11, color:'var(--muted)', marginBottom:14, padding:8, background:'#0e0f12', borderRadius:6}}>
              目标: <code>{base.trim()}/{(subfolder.trim() || tag?.name)}/</code>
            </div>
          )}

          {result && (
            <div style={{fontSize:12, padding:8, background:'#0e2a1c', borderRadius:6, marginBottom:10}}>
              ✅ 完成: {result.exported?.length || 0} {mode === 'copy' ? '复制' : '移动'}
              {result.skipped?.length ? ` · 跳过 ${result.skipped.length} (已在目标里)` : ''}
              {result.failed?.length ? ` · ${result.failed.length} 失败` : ''}
              <div style={{color:'var(--muted)', marginTop:4, wordBreak:'break-all'}}>{result.destination}</div>
            </div>
          )}
          {error && (
            <div style={{fontSize:12, padding:8, background:'#2a0e0e', borderRadius:6, marginBottom:10, color:'var(--danger)'}}>
              ❌ {error}
            </div>
          )}

          <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
            <button onClick={onClose} disabled={busy}>{result ? '关闭' : '取消'}</button>
            {!result && <button className="primary" onClick={go} disabled={busy || !base.trim()}>
              {busy ? '处理中…' : (mode === 'copy' ? '复制过去' : '剪切过去')}
            </button>}
          </div>
        </div>
      </div>
    </div>
  )
}
