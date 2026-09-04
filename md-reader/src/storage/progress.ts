const KEY = 'md-reader:progress'

/*
 * 按文档记录阅读位置。
 *
 * 先用 localStorage，不上 SQLite：v0.2 只需要一个 key-value，
 * 等 v0.3 文件库引入（要存最近文件、收藏）时再一起换成 SQLite，
 * 避免为了一处读写就背上建表与迁移的成本。
 */

function loadAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {} // 数据损坏就当没有记录，不要因此打不开文件
  }
}

/// source：从路径打开时是完整路径；从文件选择器打开时是 `file:<文件名>`。
export function readProgress(source: string): number | null {
  const value = loadAll()[source]
  return typeof value === 'number' ? value : null
}

export function saveProgress(source: string, percent: number): void {
  try {
    const all = loadAll()
    all[source] = percent
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 写不进去（配额满 / 隐私模式）不影响阅读，静默跳过
  }
}
