export type FindOptions = {
  caseSensitive: boolean
  wholeWord: boolean
}

/// CSS Custom Highlight API 的注册名。全套高亮与「当前项」分开两套，
/// 这样当前项能用更重的底色，跳转时也不用重算其余区域。
const HIGHLIGHT_ALL = 'md-reader-find'
const HIGHLIGHT_CURRENT = 'md-reader-find-current'

/*
 * 一屏高亮的数量上限。
 *
 * 正常情况下一屏只装得下几十处匹配；设上限是为了挡住病态输入 ——
 * 比如整页都是同一个字符。既是 Highlight 构造的参数个数保护，
 * 也避免为一个荒谬的输入付出荒谬的代价。
 */
const MAX_HIGHLIGHTED = 2000

/*
 * 查找痕迹（诊断用，定位完可整段删）。
 *
 * 放在模块级而不是 React 里，是为了让它**跨查找会话存活**：
 * 用户通常是「关掉查找栏以后」才想起来开诊断面板，而那时 React 状态早没了，
 * 只有这种模块级记录还能说出上一次查找到底发生了什么。
 */
export const findTrace = {
  /// 这个 WebView2 到底支不支持 CSS Custom Highlight API。
  /// **必须在模块加载时就判定**：如果只在 findOffsets 里赋值，
  /// 用户没搜索过就开面板会看到「不支持」的假警报（v0.2.8 的报告里就误报过一次）。
  supported: registry() !== null,
  /// 最近一次摊平拿到了多少文本节点
  lastChunks: 0,
  /// 最近一次搜索命中多少处
  lastOffsets: 0,
  /// 检测到「chunks 已脱离文档」并触发重算的次数
  staleHeals: 0,
  /// paintHighlights 真实执行了多少次
  paintCalls: 0,
  /// 最近一次注册到 CSS.highlights 的 Range 数量（全套 / 当前项）
  registeredAll: 0,
  registeredCurrent: 0,
  /// 最近一次异常，异常内容直接决定下一步怎么改
  lastError: '',
}

/// HighlightRegistry 的最小形状：只用到这三个成员，不依赖 lib.dom 的完整性。
type Registry = {
  set(name: string, highlight: Highlight): void
  delete(name: string): boolean
}

/*
 * 取高亮注册表，拿不到就返回 null。
 *
 * 这里原本是直接 `CSS.highlights.set(...)`。万一这个 WebView2 不支持，
 * 那就是当场抛 TypeError，而它发生在 useEffect 里 —— React 会把整棵树打掉，
 * 症状会远远超出「查找不高亮」。所以全部访问改走这个守卫。
 */
function registry(): Registry | null {
  if (typeof CSS === 'undefined') return null
  const value = (CSS as unknown as { highlights?: Registry }).highlights
  return value && typeof value.set === 'function' ? value : null
}

/*
 * chunks 里的文本节点还在文档里吗？
 *
 * 正文内容被整体换掉之后，之前摊平时记下的 Text 节点会脱离文档树。
 * 用它们建出来的 Range 有两个后果，正好对应用户报的两个症状：
 *   1. 不着色 —— 离线 Range 在页面上没有对应的渲染区域
 *   2. 跳转偏掉 —— getBoundingClientRect() 对离线 Range 返回全 0，
 *      scrollToRange 按 0 去算，于是「上下翻不对」
 * 所以这一项是判断「内容有没有被换掉」的独立证据。
 */
export function isFresh(result: FindResult): boolean {
  if (result.chunks.length === 0) return true
  return result.chunks[0].node.isConnected
}

/// 一个文本节点在摊平后的全文里从哪儿开始。
type Chunk = { node: Text; start: number }

/*
 * 查找结果：只记偏移，不建 Range。
 *
 * 这是整套查找的性能关键，来源是实测（跑 tests/bench.ts）：
 * 1 MB 文档上搜一个出现 8856 次的词，摊平 3 ms、正则匹配 7 ms，
 * 而给每一处都建 Range 要 5311 ms —— 99.9% 的耗时在 document.createRange() 上。
 * 真实文档里匹配数轻松过万，全量建 Range 必然超时。
 *
 * 于是拆成两步：这里只算偏移（毫秒级），真正要上色时才把**需要的少数几个**
 * 偏移转成 Range（见 rangeAt / paintHighlights）。匹配总数与跳转定位都是
 * 偏移数组的副产品，几乎免费。
 */
export type FindResult = {
  chunks: Chunk[]
  /// 每处匹配在摊平文本里的起始偏移，升序
  offsets: number[]
  /// 每处匹配的长度，与 offsets 一一对应。存下来免得用到时再算一遍。
  lengths: number[]
}

/*
 * 把根节点下的文本摊平成一条连续字符串，同时记下每个文本节点的起始偏移。
 *
 * 摊平这一步是跨元素匹配的基础。`**加粗**` 会把一个词拆进三个文本节点，
 * 只在单个节点内做 indexOf，跨节点的关键词就会漏配。摊平后先在整串上找，
 * 再按偏移映射回 Range，跨元素匹配自然就成立了。
 */
function flatten(root: HTMLElement): { text: string; chunks: Chunk[] } {
  const chunks: Chunk[] = []
  let text = ''

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const content = node.textContent ?? ''
    if (content.length > 0) {
      chunks.push({ node: node as Text, start: text.length })
      text += content
    }
    node = walker.nextNode()
  }

  return { text, chunks }
}

/// 全文偏移 → (文本节点, 节点内偏移)。chunks 按 start 升序，用二分。
function locate(chunks: Chunk[], offset: number): Chunk & { offset: number } {
  let low = 0
  let high = chunks.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (chunks[mid].start <= offset) low = mid
    else high = mid - 1
  }
  return { ...chunks[low], offset: offset - chunks[low].start }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 扫出所有匹配的位置。这一步不建任何 Range，所以很快（毫秒级）。
 *
 * 返回的结果里 offsets 是空的表示没匹配上；chunks 保留着，
 * 后续 rangeAt 要靠它把偏移映射回 DOM。
 */
export function findOffsets(
  root: HTMLElement,
  query: string,
  options: FindOptions,
): FindResult {
  const { text, chunks } = flatten(root)
  const offsets: number[] = []
  const lengths: number[] = []

  findTrace.supported = registry() !== null
  findTrace.lastChunks = chunks.length

  if (!query || chunks.length === 0) {
    findTrace.lastOffsets = 0
    return { chunks, offsets, lengths }
  }

  // \b 依赖拉丁字母的词边界，对中文无效（汉字之间不存在 \b）。
  // 全词匹配因此只对英文生效，这是已知限制。
  const pattern = options.wholeWord ? `\\b${escapeRegExp(query)}\\b` : escapeRegExp(query)
  const regex = new RegExp(pattern, options.caseSensitive ? 'g' : 'gi')

  for (const match of text.matchAll(regex)) {
    if (match[0].length === 0) continue // 空匹配会让正则原地打转
    offsets.push(match.index ?? 0)
    lengths.push(match[0].length)
  }

  findTrace.lastOffsets = offsets.length
  return { chunks, offsets, lengths }
}

/// 把第 index 处匹配转成一个 Range。**全场唯一建 Range 的入口**，调用要有节制。
export function rangeAt(result: FindResult, index: number): Range | null {
  const { chunks, offsets, lengths } = result
  if (index < 0 || index >= offsets.length) return null

  const from = offsets[index]
  const start = locate(chunks, from)
  const end = locate(chunks, from + lengths[index])

  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

/// 第一个使 predicate 为真的下标；全为假则返回 length。
function lowerBound(length: number, predicate: (index: number) => boolean): number {
  let low = 0
  let high = length
  while (low < high) {
    const mid = (low + high) >> 1
    if (predicate(mid)) high = mid
    else low = mid + 1
  }
  return low
}

/*
 * 当前视口（上下各留一屏余量）覆盖了哪一段匹配。
 *
 * 匹配按偏移升序，在文档里的垂直位置也随之单调递增，所以
 * 「第 i 处是否已越过视口顶部」是个单调谓词，可以二分。
 * 每次判定要建一个 Range 再量一次 rect —— 二分只要 O(log n) 次，
 * 比给全部匹配建 Range 便宜几个数量级。
 */
export function visibleIndices(
  result: FindResult,
  container: HTMLElement,
): { from: number; to: number } {
  const total = result.offsets.length
  if (total === 0) return { from: 0, to: -1 }

  const view = container.getBoundingClientRect()
  const top = view.top - container.clientHeight
  const bottom = view.bottom + container.clientHeight

  const from = lowerBound(total, (index) => {
    const rect = rangeAt(result, index)?.getBoundingClientRect()
    return rect ? rect.bottom >= top : true
  })

  // 第一个「已越过底部」的下标，再往前一格就是最后一个可见的
  const to = lowerBound(total, (index) => {
    const rect = rangeAt(result, index)?.getBoundingClientRect()
    return rect ? rect.top > bottom : false
  }) - 1

  if (to < from) return { from: 0, to: -1 }
  return { from, to }
}

/*
 * 上一次上色的区间，用来跳过无谓的重绘。
 *
 * 滚动时每帧都会调 paintHighlights，而可见区间带了上下各一屏的余量，
 * 意味着要滚过整整一屏区间才会真的变一次。不跳过的话，每一帧都要白建
 * 上百个 Range —— 这正是 60 fps 那条指标要省下来的开销。
 *
 * 缓存里带上 result 是为了换新文档时不误判：新文档的 FindResult 是不同的对象，
 * 即使 from/to 恰好相同也必须重画，否则会把旧文档的 Range 留在屏幕上。
 * 同一时刻只会有一个查找会话，所以模块级单份缓存是安全的。
 */
let lastPainted: { result: FindResult; from: number; to: number; current: number } | null = null

/**
 * 上色：只给视口里（含上下各一屏）的匹配建 Range。
 *
 * 用 CSS Custom Highlight API，不插 <mark>，不污染 DOM 也不触发重排。
 * 滚动时由调用方重新调用本函数补上新高亮。
 */
export function paintHighlights(
  result: FindResult,
  container: HTMLElement,
  currentIndex: number,
): void {
  if (result.offsets.length === 0) {
    clearHighlights()
    return
  }

  findTrace.paintCalls += 1

  const store = registry()
  if (!store) {
    findTrace.lastError = 'CSS.highlights 不可用 —— 必须回退到 <mark> 包裹方案'
    return
  }

  const { from, to } = visibleIndices(result, container)
  if (
    lastPainted &&
    lastPainted.result === result &&
    lastPainted.from === from &&
    lastPainted.to === to &&
    lastPainted.current === currentIndex
  ) {
    return // 区间没变，上一帧画的还在
  }
  lastPainted = { result, from, to, current: currentIndex }

  const ranges: Range[] = []
  for (let i = from; i <= to && ranges.length < MAX_HIGHLIGHTED; i++) {
    const range = rangeAt(result, i)
    if (range) ranges.push(range)
  }

  if (ranges.length > 0) store.set(HIGHLIGHT_ALL, new Highlight(...ranges))
  else store.delete(HIGHLIGHT_ALL)
  findTrace.registeredAll = ranges.length

  // 当前项单独一套，用更重的底色。它可能在视口外（刚跳转还没滚过去），
  // 单独建一个 Range 很便宜，不必受视口限制。
  const current = rangeAt(result, currentIndex)
  if (current) store.set(HIGHLIGHT_CURRENT, new Highlight(current))
  else store.delete(HIGHLIGHT_CURRENT)
  findTrace.registeredCurrent = current ? 1 : 0
}

export function clearHighlights(): void {
  lastPainted = null
  findTrace.registeredAll = 0
  findTrace.registeredCurrent = 0
  // 关查找、切文档都会走到这里。拿不到注册表时静默返回即可 ——
  // 没有高亮可清，本来就是目标状态。
  registry()?.delete(HIGHLIGHT_ALL)
  registry()?.delete(HIGHLIGHT_CURRENT)
}

export function scrollToRange(range: Range, container: HTMLElement): void {
  const target = range.getBoundingClientRect()
  const view = container.getBoundingClientRect()
  container.scrollTo({
    top:
      container.scrollTop + target.top - view.top - container.clientHeight / 2 + target.height / 2,
    behavior: 'smooth',
  })
}
