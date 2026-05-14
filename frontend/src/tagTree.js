// Utility helpers for treating the flat tag list as a tree.

export function buildTagTree(tags) {
  const byId = new Map(tags.map(t => [t.id, { ...t, children: [] }]))
  const roots = []
  for (const node of byId.values()) {
    if (node.parent_id != null && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  }
  // Stable in-place sort: favorites first, then name.
  const sortByFavName = (a, b) => {
    if ((b.is_favorite || 0) !== (a.is_favorite || 0)) return (b.is_favorite || 0) - (a.is_favorite || 0)
    return a.name.localeCompare(b.name, 'zh-CN')
  }
  const sortRec = (arr) => {
    arr.sort(sortByFavName)
    for (const n of arr) sortRec(n.children)
  }
  sortRec(roots)
  return { roots, byId }
}

export function tagPath(byId, id) {
  const out = []
  let cur = byId.get(id)
  while (cur) {
    out.unshift(cur.name)
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null
  }
  return out
}

export function descendantIds(byId, id) {
  const out = new Set()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()
    const node = byId.get(cur)
    if (!node) continue
    for (const c of node.children) {
      out.add(c.id)
      stack.push(c.id)
    }
  }
  return out
}
