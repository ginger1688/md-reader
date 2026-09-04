import { JSDOM } from 'jsdom'

/*
 * 大文档性能基准。
 *
 * 测 v0.2 出口条件里能量化的两项（PRD §6）：
 *   - 1 MB Markdown 首屏渲染 ≤ 500 ms
 *   - 5 MB 文档首次查找响应 ≤ 300 ms
 *
 * 两点必须在看数字前知道：
 *
 * 1. **跑在 jsdom 里，不是 Chromium**。jsdom 的 DOM 操作与 HTML 解析慢得多，
 *    所以这里是**悲观下界**：过了不代表真机上富余，但不过一定有问题。
 *
 * 2. **5 MB 文档无法在 jsdom 里整体落地**。光是把 10 MB 的 HTML 塞进 innerHTML
 *    就要几分钟，而这是 jsdom 解析器的问题，真机上不会这样。所以分成两段测：
 *     1 MB 走完整的 DOM 管线，再按线性外推到 5 MB；
 *     5 MB 只测不依赖 DOM 解析的那部分（纯文本扫描），作为算法下限。
 *
 * 跑：npm run bench
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window as unknown as Window & typeof globalThis
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node
globalThis.NodeFilter = dom.window.NodeFilter
globalThis.Range = dom.window.Range
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.DocumentFragment = dom.window.DocumentFragment
globalThis.HTMLTemplateElement = dom.window.HTMLTemplateElement
globalThis.Text = dom.window.Text
globalThis.Element = dom.window.Element

const { findOffsets, rangeAt } = await import('../src/find/index')
const { collectHeadings } = await import('../src/markdown/headings')
const { sanitizeHtml } = await import('../src/markdown/sanitize')

/*
 * 这里用的是真实的 renderMarkdown（markdown-it + 代码高亮 + DOMPurify）。
 * 能这么做是因为 highlight.ts 已经把 import.meta.glob 抽到了 languages.ts，
 * 渲染链不再依赖 Vite 专有语法 —— 在那之前，Node 下 import 它就直接报错。
 *
 * 唯一没走到的路径是冷门语言的按需加载（那份 glob 表只有 Vite 认得），
 * 而基准文档只用了 python，属于预加载的 24 种之一，不受影响。
 */
const { renderMarkdown } = await import('../src/markdown/render')
const { detectCodeLanguages, ensureLanguages } = await import('../src/markdown/highlight')

/*
 * 造一份「像真的」大文档。
 *
 * 不能是一整段文字 —— 那测不出 TreeWalker 与 querySelectorAll 在节点数上的开销。
 * 真实的 md 是标题、段落、代码块、表格混着来的。
 */
function generateMarkdown(targetBytes: number): string {
  const parts: string[] = []
  let size = 0
  let section = 0

  // 增量累加。每轮 join 整个数组算长度是 O(n²)，5 MB 的文档会跑到天荒地老。
  const push = (text: string) => {
    parts.push(text)
    size += Buffer.byteLength(text, 'utf8')
  }

  while (size < targetBytes) {
    section++
    push(`\n## 第 ${section} 节 标题\n`)
    push(
      `这是第 ${section} 节的正文段落，用来观察**加粗**、*斜体*、\`行内代码\` 与 [链接](https://example.com/${section}) 在长文档里的表现。中文与 English 混排。\n`,
    )
    for (let p = 0; p < 12; p++) {
      push(
        `段落 ${section}.${p}：Markdown 阅读器需要让长文档在屏幕上读起来不累，行高、段间距、正文宽度都要仔细调过。这里再重复一遍关键词「阅读器」，供查找基准使用。\n`,
      )
    }
    if (section % 5 === 0) {
      push('\n```python\ndef render(doc: str) -> str:\n    return doc.strip()\n```\n')
    }
    if (section % 10 === 0) {
      push('\n| 列一 | 列二 | 列三 |\n|---|---|---|\n| A | B | C |\n| D | E | F |\n')
    }
  }

  return parts.join('')
}

function bench<T>(label: string, target: number | null, fn: () => T): T {
  const started = performance.now()
  const result = fn()
  const elapsed = performance.now() - started
  const suffix =
    target === null ? '' : elapsed <= target ? `   ✓ ≤ ${target} ms` : `   ✗ 超出 ${target} ms`
  console.log(`    ${label.padEnd(30)} ${elapsed.toFixed(0).padStart(6)} ms${suffix}`)
  return result
}

const MB = (text: string) => (Buffer.byteLength(text, 'utf8') / 1e6).toFixed(2)

console.log('\n── 生成测试文档 ──')
const doc1mb = bench('1 MB 文档生成', null, () => generateMarkdown(1_000_000))
const doc5mb = bench('5 MB 文档生成', null, () => generateMarkdown(5_000_000))
console.log(`    实际大小：1 MB → ${MB(doc1mb)} MB，5 MB → ${MB(doc5mb)} MB`)

console.log('\n── 渲染：真实管线（markdown-it + 代码高亮 + DOMPurify）──')
await ensureLanguages(detectCodeLanguages(doc5mb))
const html1mb = bench('1 MB 渲染（目标 500 ms）', 500, () => renderMarkdown(doc1mb))
const html5mb = bench('5 MB 渲染（参考）', null, () => renderMarkdown(doc5mb))
console.log(`    HTML 体积：1 MB → ${MB(html1mb)} MB，5 MB → ${MB(html5mb)} MB`)

console.log('\n── 1 MB 文档的完整 DOM 管线 ──')
const root = document.createElement('div')
root.innerHTML = html1mb
document.body.appendChild(root)
console.log(`    元素节点数：${root.querySelectorAll('*').length}（文本节点另计）`)

bench('提取标题', null, () => collectHeadings(root))

/*
 * 查找分两步量：
 *   ① 扫偏移 —— 用户输入关键词时的实际开销，这是 300 ms 要卡的那一刀
 *   ② 建 Range —— 只给视口内的匹配建，数量少，单独看它有多便宜
 *
 * jsdom 不做排版，它的 Range 连 getBoundingClientRect 都没有，
 * 所以 visibleIndices 在这里跑不了（真机 Chromium 上正常）。
 * 建 Range 那一步按「一屏 100 处」估，比真实视口只多不少。
 */
console.log('\n── 查找（1 MB 文档，对照 5 MB ≤ 300 ms 的目标）──')
const queries: [string, string][] = [
  ['阅读器', '高频词'],
  ['Markdown', '中频英文'],
  ['的', '低频中文'],
]
for (const [query, kind] of queries) {
  const result = bench(`扫偏移「${query}」(${kind})`, 300, () =>
    findOffsets(root, query, { caseSensitive: false, wholeWord: false }),
  )
  const perScreen = Math.min(result.offsets.length, 100)
  bench(`  建 Range × ${perScreen}（一屏）`, null, () => {
    for (let i = 0; i < perScreen; i++) rangeAt(result, i)
  })
  console.log(
    `        匹配 ${result.offsets.length} 处 → 外推 5 MB 约 ${result.offsets.length * 5} 处`,
  )
}

console.log('\n── 5 MB 纯文本扫描（不含 DOM，算法下限）──')
// 摊平 DOM 后剩下的就是一次正则全扫，这一步不依赖 jsdom，
// 可以拿 5 MB 的渲染结果直接量。
const text5mb = html5mb.replace(/<[^>]*>/g, '')
console.log(`    去标签后文本：${MB(text5mb)} MB`)
bench('正则全扫「的」', null, () => {
  let count = 0
  for (const _ of text5mb.matchAll(/的/g)) count++
  return count
})

/*
 * 对照：旧实现（给每一处匹配都建 Range）的成本。
 *
 * 留着这段是为了说明为什么要拆 —— 扫偏移只要 4 ms，建 8856 个 Range 要 6 秒，
 * 中间差三个数量级。改造后建 Range 的数量被限制在一屏之内（约 100 个，见上）。
 */
console.log('\n── 对照：全量建 Range 的成本（改造前的做法）──')
const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
let probeNode = walker.nextNode() as Text
bench('TreeWalker 摊平', null, () => {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  let n = w.nextNode()
  while (n) {
    total += (n.textContent ?? '').length
    n = w.nextNode()
  }
  return total
})

const flat = (() => {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  let n = w.nextNode()
  while (n) {
    text += n.textContent ?? ''
    n = w.nextNode()
  }
  return text
})()
console.log(`    摊平后文本长度：${(flat.length / 1e6).toFixed(2)} M 字符`)

const offsets = bench('正则匹配（只取偏移）', null, () => {
  const found: number[] = []
  for (const m of flat.matchAll(/阅读器/g)) found.push(m.index ?? 0)
  return found
})
console.log(`    匹配数：${offsets.length}`)

bench(`建 Range × ${offsets.length}`, null, () => {
  const ranges: Range[] = []
  for (let i = 0; i < offsets.length; i++) {
    const range = document.createRange()
    range.setStart(probeNode, 0)
    range.setEnd(probeNode, 1)
    ranges.push(range)
  }
  return ranges.length
})

console.log('')
