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
  startScanFiles: (files, runAi = true) =>
    req('/api/scan', { method: 'POST', body: JSON.stringify({ files, run_ai: runAi }) }),
  scanStatus: () => req('/api/scan/status'),
  cancelScan: () => req('/api/scan/cancel', { method: 'POST' }),
  listShots: (params = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v)
    }
    return req('/api/shots?' + qs.toString())
  },
  photoDetail: (id) => req(`/api/photo/${id}/detail`),
  listFolders: () => req('/api/folders'),
  deleteFolder: (id) => req(`/api/folders/${id}`, { method: 'DELETE' }),
  recompute: (folder, runAi = false, preset = 'intermediate') =>
    req('/api/recompute', {
      method: 'POST',
      body: JSON.stringify({ folder: folder || null, run_ai: runAi, preset }),
    }),
  backfillExif: (folder, onlyMissing = true) =>
    req('/api/backfill-exif', {
      method: 'POST',
      body: JSON.stringify({ folder: folder || null, only_missing: onlyMissing }),
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
  revealInFinder: (photo_id) =>
    req('/api/reveal', { method: 'POST', body: JSON.stringify({ photo_id }) }),
  revealPath: (path) =>
    req('/api/reveal-path', { method: 'POST', body: JSON.stringify({ path }) }),
  pickFolder: () => req('/api/pick-folder', { method: 'POST' }),
  pickFiles: () => req('/api/pick-files', { method: 'POST' }),
  exportTag: (tag_id, opts = {}) =>
    req('/api/export-tag', {
      method: 'POST',
      body: JSON.stringify({ tag_id, ...opts }),
    }),
  moveTagToSubfolder: (tag_id) =>
    req('/api/move-tag-to-subfolder', { method: 'POST', body: JSON.stringify({ tag_id }) }),
  findMoveTarget: (folder, name = 'ToReview') => {
    const qs = new URLSearchParams({ folder, name })
    return req('/api/find-move-target?' + qs.toString())
  },
  emptyMoveTarget: (folder, name = 'ToReview') =>
    req('/api/empty-move-target', {
      method: 'POST',
      body: JSON.stringify({ folder, name, remove_empty_dirs: true }),
    }),
  annotate: (photo_id, bird_bbox, eye_xy) =>
    req('/api/annotate', { method: 'POST', body: JSON.stringify({ photo_id, bird_bbox, eye_xy }) }),
  similarGroups: (folder, threshold = 24) => {
    const qs = new URLSearchParams({ folder, threshold })
    return req('/api/similar-groups?' + qs.toString())
  },
  thumbUrl: (id) => `/api/thumb/${id}`,
  fullUrl: (id, maxSide = 3600) => `/api/full/${id}?max_side=${maxSide}`,
  // ----- tags -----
  listTags: () => req('/api/tags'),
  createTag: (name, opts = {}) =>
    req('/api/tags', { method: 'POST', body: JSON.stringify({ name, ...opts }) }),
  updateTag: (id, patch) =>
    req(`/api/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTag: (id) => req(`/api/tags/${id}`, { method: 'DELETE' }),
  batchPhotoTags: (photo_ids, { add_tag_ids = [], remove_tag_ids = [], add_tag_names = [] } = {}) =>
    req('/api/photo-tags/batch', {
      method: 'POST',
      body: JSON.stringify({ photo_ids, add_tag_ids, remove_tag_ids, add_tag_names }),
    }),
  // ----- stacking -----
  startStack: ({ photo_ids, anchor_id, source = 'jpeg', mode = 'sigma_clip', align = true, full_size = false }) =>
    req('/api/stack', {
      method: 'POST',
      body: JSON.stringify({ photo_ids, anchor_id, source, mode, align, full_size }),
    }),
  stackStatus: (task_id) => {
    const qs = new URLSearchParams({ task_id })
    return req('/api/stack/status?' + qs.toString())
  },
  stackResultUrl: (task_id, kind = 'full') =>
    `/api/stack/result/${task_id}?kind=${kind}`,
  listStacks: () => req('/api/stacks'),
  stackFileUrl: (name, kind = 'full') => {
    const qs = new URLSearchParams({ name, kind })
    return '/api/stacks/file?' + qs.toString()
  },
}
