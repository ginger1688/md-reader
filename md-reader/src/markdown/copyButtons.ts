/*
 * 给代码块和表格装上「复制」按钮。
 *
 * 装在 markdown HTML 渲染落地之后：用 dangerouslySetInnerHTML 把整段
 * HTML 塞进 <article>, 然后命令式地给每个 <pre> 和 <table> 加按钮。
 *
 * 不把按钮写进 markdown HTML 的原因：DOMPurify 会按白名单清掉所有
 * 非排版标签，硬塞 <button> 会被剥，复制交互也就没了。
 * 命令式注入则绕开了 sanitize，且按钮挂在文档结构层之外，
 * 复制时不影响 markdown 源文本的纯度。
 */

/*
 * markdown HTML 不带 hljs 的 span 概念 —— 它在 markdown-it 的 highlight 钩子里
 * 由我们用 `<span class="hljs-...">` 注入的。这些 span 拆的是样式，不该带走语义。
 * textContent 会把 span 拍平成纯文本，正好就是用户想复制的代码。
 *
 * 行尾空白（含换行）也一并吞掉：hljs 在末尾补 \n 是它的渲染惯例，
 * 但粘贴到别处会带个尾随空行。
 */
function codeText(pre: HTMLPreElement): string {
  const code = pre.querySelector('code')
  const raw = (code ?? pre).textContent ?? ''
  return raw.replace(/\s+$/u, '')
}

/*
 * HTML 表格 → Markdown 表格。
 *
 * 之所以手写而不用现成库：输入就是 sanitize 过的 <table>，结构干净，
 * 不需要考虑千奇百怪的 HTML 表格。一个 30 行的纯函数比引依赖划算。
 *
 * - thead / tbody / tfoot 顺序按 DOM 顺序保留；多行表头也照原样转成多行
 * - 对齐：th/td 的 align 属性若是 left/center/right，对应列写成 `:---`/`:---:`/`---:`
 *   没有 align 就用默认 `---`，与 GFM 一致
 * - 单元格里的换行转成 `<br>`，再转成空格：Markdown 表格一行就是一物理行，
 *   真要保留多行结构得引入 raw HTML，反而把读者绕进去
 * - 空单元格也要占位：`| a |  | b |` 不是合法的 Markdown 表格，少一格列数对不齐
 */
function tableToMarkdown(table: HTMLTableElement): string {
  const rows: { cells: string[]; isHeader: boolean; aligns: (string | null)[] }[] = []

  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells: string[] = []
    const aligns: (string | null)[] = []
    for (const cell of Array.from(tr.children) as HTMLElement[]) {
      const tag = cell.tagName.toLowerCase()
      if (tag !== 'td' && tag !== 'th') continue
      const align = cell.getAttribute('align')
      const text = (cell.textContent ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        // Markdown 表格里 | 是分隔符，遇到要转义
        .replace(/\|/g, '\\|')
      cells.push(text)
      aligns.push(align)
    }
    if (cells.length === 0) continue
    const isHeader = tr.parentElement?.tagName.toLowerCase() === 'thead'
    rows.push({ cells, isHeader, aligns })
  }

  if (rows.length === 0) return ''

  const header = rows.find((r) => r.isHeader)
  const body = rows.filter((r) => !r.isHeader)
  const columns = (header ?? body[0]).cells.length

  // 对齐序列取自表头，没有表头就用每行第一格（align 通常每列统一）
  const aligns: (string | null)[] = []
  if (header) {
    aligns.push(...header.aligns)
  } else {
    for (let i = 0; i < columns; i++) aligns.push(null)
  }
  while (aligns.length < columns) aligns.push(null)

  const formatSeparator = (align: string | null): string => {
    if (align === 'center') return ':---:'
    if (align === 'right' || align === 'end') return '---:'
    if (align === 'left' || align === 'start') return ':---'
    return '---'
  }

  const lines: string[] = []

  if (header) {
    lines.push(`| ${header.cells.join(' | ')} |`)
  } else {
    // 没有 thead 的表格也要给 GFM 风格的占位表头，否则多数 Markdown 渲染器不识别
    lines.push(`| ${Array.from({ length: columns }, () => '').join(' | ')} |`)
  }
  lines.push(`| ${aligns.map(formatSeparator).join(' | ')} |`)

  const bodyRows = body.length > 0 ? body : header ? [header] : []
  for (const row of bodyRows) {
    const padded = row.cells.slice()
    while (padded.length < columns) padded.push('')
    lines.push(`| ${padded.join(' | ')} |`)
  }

  return lines.join('\n')
}

/*
 * 装按钮：每个 pre / table 右上角一个。
 *
 * 标签语言由调用方传，避免这里耦合 i18n。
 *
 * 按钮里只是文字 + 点击事件，不依赖 React，所以这里走纯 DOM API：
 * 安装完返回的卸载函数可以在文档切换时把全部按钮清掉。
 *
 * 把按钮放在一个包装 div 里、用 absolute 定位，能在不破坏 <pre> / <table>
 * 现有定位的前提下让按钮跟随容器 —— 直接挂到 pre/table 上会用 inline 排版，
 * 把代码块高度撑大一截。
 */
type InstallOptions = {
  copyLabel: string
  copiedLabel: string
}

export function installCopyButtons(root: HTMLElement, options: InstallOptions): () => void {
  const markers: HTMLElement[] = []

  const make = (container: HTMLElement, getText: () => string) => {
    const wrap = document.createElement('div')
    wrap.className = 'md-copy-host'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'md-copy-btn'
    btn.textContent = options.copyLabel
    btn.addEventListener('click', () => {
      const text = getText()
      const finish = () => {
        btn.textContent = options.copiedLabel
        btn.classList.add('copied')
        setTimeout(() => {
          btn.textContent = options.copyLabel
          btn.classList.remove('copied')
        }, 1500)
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(finish).catch(() => fallbackCopy(text, finish))
      } else {
        fallbackCopy(text, finish)
      }
    })
    wrap.appendChild(btn)
    /*
     * 定位上下文（position: relative）由 markdown.css 给 .markdown-body pre / table 设置。
     * 这是个跨文件的隐性约定：v0.2.2 装机实测发现 pre 的 position: relative 漏设，
     * 导致复制按钮脱离定位飞到 viewport 外看不见 —— 任何一处改了 markdown.css
     * 的 pre/table 排版，都要回头确认这条约定还在。
     */
    container.appendChild(wrap)
    markers.push(wrap)
  }

  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const element = pre as HTMLPreElement
    make(element, () => codeText(element))
  }
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const element = table as HTMLTableElement
    make(element, () => tableToMarkdown(element))
  }

  return () => {
    for (const m of markers) m.remove()
  }
}

/*
 * 剪贴板 API 在非安全上下文或被禁用时会拒绝调用 —— 比如用 file:// 协议打开的页面。
 * 用一个隐藏 textarea 走 document.execCommand('copy') 是最后兜底。
 * 删掉临时节点后没人看得到，体验上仍然是「一键」。
 */
function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.top = '-9999px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    done()
  } catch {
    // 用户拒绝授权或剪贴板不可写 —— 这里静默，按钮文案不变回旧值也行
  } finally {
    ta.remove()
  }
}