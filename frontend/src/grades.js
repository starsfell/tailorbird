// 选片等级:四个互斥的固定标签(一张照片最多一个等级),和精修/保留一样走普通标签,
// 所以会写回原图 Keywords、能在标签面板里筛选。改名只改这里的 tag。
export const GRADES = [
  { key: 'A', tag: 'A·参赛', label: '参赛级', color: '#e8524a' },
  { key: 'B', tag: 'B·优秀', label: '优秀', color: '#4a9eff' },
  { key: 'C', tag: 'C·证件照', label: '证件照', color: '#a48cff' },
  { key: 'D', tag: 'D·最差', label: '最差', color: '#8a8f98' },
]

export function gradeOf(shot) {
  const names = new Set((shot.tags || []).map(t => t.name))
  return GRADES.find(g => names.has(g.tag)) || null
}
