// Utility helpers for treating the flat tag list as a tree.
import { pinyin } from 'pinyin-pro'

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
  // Stable in-place sort: favorites first, then name with natural-number
  // ordering so "ISO 100" < "ISO 1000" < "ISO 12800" and "200mm" < "1000mm".
  const sortByFavName = (a, b) => {
    if ((b.is_favorite || 0) !== (a.is_favorite || 0)) return (b.is_favorite || 0) - (a.is_favorite || 0)
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
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

// 标签名搜索:中文子串,或拼音全拼 / 首字母(「hfbh」「heifu」都能找到「黑腹滨鹬」)。
// 拼音按标签名缓存,树每次过滤都会把所有标签扫一遍。
const pinyinCache = new Map()
function pinyinKeys(name) {
  let k = pinyinCache.get(name)
  if (!k) {
    const syl = pinyin(name, { toneType: 'none', type: 'array', v: true }).map(s => s.toLowerCase())
    k = { full: syl.join(''), initials: syl.map(s => s[0] || '').join('') }
    pinyinCache.set(name, k)
  }
  return k
}

export function tagNameMatches(name, query) {
  const q = (query || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!q) return true
  const n = (name || '').toLowerCase()
  if (n.replace(/\s+/g, '').includes(q)) return true
  if (!/^[a-z]+$/.test(q)) return false
  const { full, initials } = pinyinKeys(name || '')
  return full.includes(q) || initials.includes(q)
}
