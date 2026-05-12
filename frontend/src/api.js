const BASE = ''  // proxied by Vite to localhost:7891

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

export const api = {
  startScan: (folder, runAi = true) =>
    req('/api/scan', { method: 'POST', body: JSON.stringify({ folder, run_ai: runAi }) }),
  scanStatus: () => req('/api/scan/status'),
  listShots: (params = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v)
    }
    return req('/api/shots?' + qs.toString())
  },
  photoDetail: (id) => req(`/api/photo/${id}/detail`),
  listFolders: () => req('/api/folders'),
  recompute: (folder, runAi = false, preset = 'intermediate') =>
    req('/api/recompute', {
      method: 'POST',
      body: JSON.stringify({ folder: folder || null, run_ai: runAi, preset }),
    }),
  listPresets: () => req('/api/presets'),
  applyPreset: (folder, preset) =>
    req('/api/presets/apply', {
      method: 'POST',
      body: JSON.stringify({ folder: folder || null, preset }),
    }),
  deletePhotos: (photo_ids, pair_with_sidecar = true, mode = 'trash', subfolder_name = 'ToReview') =>
    req('/api/delete', {
      method: 'POST',
      body: JSON.stringify({ photo_ids, pair_with_sidecar, mode, subfolder_name }),
    }),
  writeXmp: (photo_ids) =>
    req('/api/exif/write', { method: 'POST', body: JSON.stringify({ photo_ids }) }),
  clearXmp: (photo_ids) =>
    req('/api/exif/clear', { method: 'POST', body: JSON.stringify({ photo_ids }) }),
  openFolder: (path) =>
    req('/api/open-folder', { method: 'POST', body: JSON.stringify({ path }) }),
  findMoveTarget: (folder, name = 'ToReview') => {
    const qs = new URLSearchParams({ folder, name })
    return req('/api/find-move-target?' + qs.toString())
  },
  annotate: (photo_id, bird_bbox, eye_xy) =>
    req('/api/annotate', { method: 'POST', body: JSON.stringify({ photo_id, bird_bbox, eye_xy }) }),
  similarGroups: (folder, threshold = 24) => {
    const qs = new URLSearchParams({ folder, threshold })
    return req('/api/similar-groups?' + qs.toString())
  },
  thumbUrl: (id) => `/api/thumb/${id}`,
  fullUrl: (id, maxSide = 3600) => `/api/full/${id}?max_side=${maxSide}`,
}
