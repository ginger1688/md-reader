/*
 * 文档区的最大宽度占父容器百分比。
 *
 * 与阅读进度一样按 key-value 存，不引入 SQLite：
 * 只有一个 number 字段，键值更省事。
 */

/// 允许的百分比档位。范围锁定 60–100 是用户拍板的；写在这里比写在 JS 里更醒目，
/// 后面接「更窄」档位（比如 50%）时也能一眼看到该改两处。
const ALLOWED = [60, 70, 80, 90, 100] as const
export type ReaderWidth = (typeof ALLOWED)[number]

const KEY = 'md-reader:reader-width'

export function loadReaderWidth(): ReaderWidth {
  const raw = localStorage.getItem(KEY)
  const value = raw ? Number(raw) : NaN
  return (ALLOWED as readonly number[]).includes(value) ? (value as ReaderWidth) : 100
}

export function saveReaderWidth(width: ReaderWidth): void {
  localStorage.setItem(KEY, String(width))
}

export const READER_WIDTH_OPTIONS = ALLOWED