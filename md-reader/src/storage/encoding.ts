const KEY = 'md-reader:encoding'

/*
 * 记住「这个文件上次是用哪种编码打开的」。
 *
 * 只有非 UTF-8 的文件才会写进来，UTF-8 的文件压根不需要记 ——
 * 不记录就等于走默认路径（先按 UTF-8 试），这正好是我们想要的。
 *
 * 和 progress.ts 一样先用 localStorage，v0.3 引入 SQLite 时一起搬过去。
 */

/// 目前支持的全部备选编码。新增编码要同步改 lib.rs 的 read_file_as。
export type Encoding = 'gbk'

function loadAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function readEncoding(source: string): Encoding | null {
  const value = loadAll()[source]
  return value === 'gbk' ? value : null
}

export function saveEncoding(source: string, encoding: Encoding): void {
  try {
    const all = loadAll()
    all[source] = encoding
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 写不进去不影响打开，只是下次要再点一次按钮
  }
}

/// 抹掉一条记忆。用在「记住的编码也解不开」时 —— 说明记忆已经过期
/// （文件可能已经换过编码了），留着它下次还会走同一条死路。
export function forgetEncoding(source: string): void {
  try {
    const all = loadAll()
    delete all[source]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 同上
  }
}
