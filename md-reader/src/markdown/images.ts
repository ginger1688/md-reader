import { convertFileSrc } from '@tauri-apps/api/core'

/// 这些协议原样保留：网络图片、内嵌图片，以及已转换过的 asset 地址
/// （Tauri 的 asset 地址形如 http://asset.localhost/...，被 https? 匹配）。
const PASSTHROUGH = /^(?:https?|data|blob):/i

/// 绝对路径：盘符开头（C:\ 或 C:/），或 POSIX 根路径（/）。
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\/)/

/// md 里允许写 URL 编码的路径，但含非法 % 序列时 decodeURIComponent 会抛错。
function decode(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

/*
 * 把一个 <img src> 解析成 WebView 能加载的地址。
 *
 * 页面基址是 http://localhost:1420（开发）或 tauri://localhost（打包后），
 * 所以 `./img/a.png` 这类相对路径会被解析到 dev server 根目录而 404。
 * 必须先基于 md 所在目录拼成绝对路径，再用 convertFileSrc 转成
 * asset 协议地址，WebView 才能读到这张本地图片。
 */
export function resolveImageSrc(src: string, baseDir: string): string {
  const raw = decode(src.trim())
  if (PASSTHROUGH.test(raw)) return raw

  const path = raw.replace(/^file:\/\/\/?/i, '')

  if (ABSOLUTE_PATH.test(path) || !baseDir) return convertFileSrc(path)

  return convertFileSrc(`${baseDir.replace(/[\\/]+$/, '')}\\${path}`)
}

/// 遍历渲染结果里的图片：解析路径，并为加载失败的图片准备占位块。
export function resolveImages(root: HTMLElement, baseDir: string): void {
  root.querySelectorAll('img').forEach((img) => {
    const original = img.getAttribute('src')
    if (original) img.setAttribute('src', resolveImageSrc(original, baseDir))

    // 加载失败就换成占位块，不留破图图标。
    // 不能只加 class 改样式：img 是替换元素，alt 的显示行为不受 CSS 控制。
    img.addEventListener(
      'error',
      () => {
        const placeholder = document.createElement('span')
        placeholder.className = 'broken-image'
        placeholder.textContent = original ?? img.getAttribute('alt') ?? ''
        img.replaceWith(placeholder)
      },
      { once: true },
    )
  })
}
