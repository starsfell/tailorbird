import React from 'react'
import { api } from './api.js'

function Stars({ n }) {
  if (n == null || n < 0) return <span className="badge">无鸟</span>
  return <span className="stars">{'★'.repeat(n)}{'☆'.repeat(3 - n)}</span>
}

export function Tile({ shot, selected, onToggle, onOpen }) {
  const cls = ['tile']
  if (selected) cls.push('selected')
  if (shot.is_cluster_best) cls.push('best')
  if (shot.pick) cls.push('pick')
  const sharp = shot.subject_sharpness
  const sharpLabel = sharp == null ? '—' : sharp.toFixed(2)
  const eye = shot.eye_sharpness
  const eyeLabel = eye == null ? null : eye.toFixed(1)
  const aes = shot.aesthetic_score
  const aesLabel = aes == null ? null : aes.toFixed(2)
  const conf = shot.bird_confidence
  return (
    <div
      className={cls.join(' ')}
      onClick={() => onToggle(shot.primary_id)}
      onDoubleClick={(e) => { e.stopPropagation(); onOpen && onOpen(shot) }}
      title={`${shot.stem}  ${shot.formats.join('+')}  sharp ${sharpLabel}${eyeLabel ? '  eye ' + eyeLabel : ''}${aesLabel ? '  aes ' + aesLabel : ''}`}
    >
      <img src={api.thumbUrl(shot.primary_id)} loading="lazy" alt="" />
      <div className="tile-tl">
        <Stars n={shot.rating} />
        {shot.pick && <span className="badge pick-flag">PICK</span>}
        {shot.focus_weight != null && shot.focus_weight >= 1.05 && <span className="badge focus-best">精焦</span>}
        {shot.focus_weight != null && shot.focus_weight < 0.7 && <span className="badge focus-bad">脱焦</span>}
        {shot.is_flying && <span className="badge flying">飞</span>}
        {shot.is_over && <span className="badge over">过曝</span>}
        {shot.is_under && <span className="badge under">欠曝</span>}
      </div>
      <div className="meta">
        <span className="badge">{shot.formats.join('+')}</span>
        <span className="badge sharp" title="眼部锐度 / 主体锐度">
          {eyeLabel || sharpLabel}
        </span>
        {aesLabel && <span className="badge aes" title="TOPIQ 美学">{aesLabel}</span>}
      </div>
      {conf != null && conf > 0 && (
        <span className="bird-conf" title="鸟检测置信度">{Math.round(conf * 100)}%</span>
      )}
    </div>
  )
}
