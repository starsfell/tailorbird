import React from 'react'
import { api } from './api.js'

const REFINE_TAG = '精修'
const KEEP_TAG = '保留'

function Stars({ n }) {
  if (n == null || n < 0) return <span className="badge">无鸟</span>
  return <span className="stars">{'★'.repeat(n)}{'☆'.repeat(3 - n)}</span>
}

export function Tile({ shot, selected, onToggle, onOpen, showTags = false, highlighted = false }) {
  const cls = ['tile']
  if (selected) cls.push('selected')
  if (shot.is_cluster_best) cls.push('best')
  if (shot.pick) cls.push('pick')
  if (highlighted) cls.push('search-hit')
  const sharp = shot.subject_sharpness
  const sharpLabel = sharp == null ? '—' : sharp.toFixed(2)
  const eye = shot.eye_sharpness
  const eyeLabel = eye == null ? null : eye.toFixed(1)
  const aes = shot.aesthetic_score
  const aesLabel = aes == null ? null : aes.toFixed(2)
  const conf = shot.bird_confidence
  const isRefined = (shot.tags || []).some(t => t.name === REFINE_TAG)
  const isKept = (shot.tags || []).some(t => t.name === KEEP_TAG)
  return (
    <div
      id={`tile-${shot.primary_id}`}
      className={cls.join(' ')}
      onClick={(e) => onToggle(shot.primary_id, e)}
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
        <span className="stem" title={shot.stem}>{shot.stem}</span>
        <span className="meta-right">
          <span className="badge sharp" title="眼部锐度 / 主体锐度">
            {eyeLabel || sharpLabel}
          </span>
          {aesLabel && <span className="badge aes" title="TOPIQ 美学">{aesLabel}</span>}
        </span>
      </div>
      {(isRefined || isKept || (conf != null && conf > 0)) && (
        <div className="tile-tr">
          {isRefined && <span className="badge tag-refine" title="已标「精修」">精修</span>}
          {isKept && <span className="badge tag-keep" title="已标「保留」">保留</span>}
          {conf != null && conf > 0 && (
            <span className="bird-conf" title="鸟检测置信度">{Math.round(conf * 100)}%</span>
          )}
        </div>
      )}
      {showTags && shot.tags && shot.tags.length > 0 && (
        <div className="tile-tags">
          {shot.tags.slice(0, 4).map(t => (
            <span key={t.id} className="tile-tag" style={t.color ? { background: t.color, color:'#0a1612' } : undefined}>{t.name}</span>
          ))}
          {shot.tags.length > 4 && <span className="tile-tag more">+{shot.tags.length - 4}</span>}
        </div>
      )}
    </div>
  )
}
