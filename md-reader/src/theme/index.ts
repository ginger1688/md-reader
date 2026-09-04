import './themes.css'

/// 4 套配色，与 docs/PRD.md §3.7 的色值表一一对应。
export const COLOR_THEMES = ['classic', 'paper', 'soft', 'midnight'] as const
export const SCHEMES = ['light', 'dark'] as const

export type ColorTheme = (typeof COLOR_THEMES)[number]
export type Scheme = (typeof SCHEMES)[number]
export type Theme = { color: ColorTheme; scheme: Scheme }

const KEY_COLOR = 'md-reader:color-theme'
const KEY_SCHEME = 'md-reader:scheme'

/// 查找高亮样式的 <style> 标签 id。
/// CSS Custom Highlight API 的 ::highlight() 伪元素不在 DOM 树里，
/// var() 的继承链是断的，所以这里必须塞绝对色值。
/// 主题每次切换都重新生成这段样式，跟着主题色一起变。
const FIND_HIGHLIGHT_STYLE_ID = 'find-highlight-style'

/// 从 localStorage 取值并校验合法性；没存过或值已失效（例如改名）就退回默认值。
function pick<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const saved = localStorage.getItem(key)
  return allowed.find((value) => value === saved) ?? fallback
}

export function loadTheme(): Theme {
  return {
    color: pick(KEY_COLOR, COLOR_THEMES, 'classic'),
    scheme: pick(KEY_SCHEME, SCHEMES, 'light'),
  }
}

/*
 * 把 accent 字符串换成带 alpha 的 rgba。
 *
 * themes.css 里的色值是 #rrggbb 或 rgb(r, g, b) 形式。
 * parseInt 对 NaN 会返回 NaN，NaN 写进 rgba 里浏览器直接丢弃整条规则，
 * 整个高亮就消失了 —— 比错色更糟。所以一旦解析失败就回退到原串，
 * 让浏览器报「未知颜色」而不是让我们把高亮整没了。
 */
function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed)
  if (hex) {
    const body = hex[1].length === 3
      ? hex[1].split('').map((c) => c + c).join('')
      : hex[1]
    const r = parseInt(body.slice(0, 2), 16)
    const g = parseInt(body.slice(2, 4), 16)
    const b = parseInt(body.slice(4, 6), 16)
    if ([r, g, b].some((v) => Number.isNaN(v))) return trimmed
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed)
  if (rgb) {
    const parts = rgb[1].split(',').map((p) => p.trim())
    if (parts.length < 3) return trimmed
    const r = Number(parts[0])
    const g = Number(parts[1])
    const b = Number(parts[2])
    if ([r, g, b].some((v) => !Number.isFinite(v))) return trimmed
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return trimmed
}

/*
 * 把查找高亮的 ::highlight 规则注入到一个常驻 <style>。
 *
 * 规则里只有 accent 一种变量，但用同一个色值两处（半透明底 + 实底），
 * 就在 JS 端一次性算好写出来。
 * 文本色取自当前主题的 --bg（深底配浅字、浅底配深字），
 * 这里拿不到 bg 的字符串表示时，回退到浏览器默认 currentColor，
 * 不至于让当前项变成黑底黑字完全看不见。
 */
function injectHighlightStyle(accent: string, bg: string): void {
  let style = document.getElementById(FIND_HIGHLIGHT_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = FIND_HIGHLIGHT_STYLE_ID
    document.head.appendChild(style)
  }
  const translucent = withAlpha(accent, 0.26)
  const solid = withAlpha(accent, 1)
  const currentColor = bg ? `color: ${bg};` : ''
  style.textContent =
    `::highlight(md-reader-find) { background-color: ${translucent}; }` +
    `::highlight(md-reader-find-current) { ${currentColor} background-color: ${solid}; }`
}

/// 把主题写到 <html> 的 data 属性上，剩下交给 themes.css 的属性选择器。
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.dataset.theme = theme.color
  root.dataset.scheme = theme.scheme

  // 取当前主题下 --accent 与 --bg 的实际色值，注入高亮样式。
  // 在 <html> 上读，data 属性刚切完，computed value 就是新主题的值。
  const styles = getComputedStyle(root)
  const accent = styles.getPropertyValue('--accent').trim()
  const bg = styles.getPropertyValue('--bg').trim()
  if (accent) injectHighlightStyle(accent, bg)
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(KEY_COLOR, theme.color)
  localStorage.setItem(KEY_SCHEME, theme.scheme)
}
