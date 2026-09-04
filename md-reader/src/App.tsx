import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FindBar } from './components/FindBar'
import { Lightbox, type GalleryImage } from './components/Lightbox'
import { Outline } from './components/Outline'
import { FileTree } from './components/FileTree'
import { Diagnostics, viewportFlips } from './components/Diagnostics'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  clearHighlights,
  findOffsets,
  findTrace,
  isFresh,
  paintHighlights,
  rangeAt,
  scrollToRange,
} from './find'
import type { FindResult } from './find'
import { LANGS, setLang, type Lang } from './i18n'
import { collectHeadings, findActiveHeading, type Heading } from './markdown/headings'
import { installCopyButtons } from './markdown/copyButtons'
import { resolveImages } from './markdown/images'
import { detectCodeLanguages, ensureLanguages } from './markdown/highlight'
import { renderMarkdown } from './markdown/render'
import { readProgress, saveProgress } from './storage/progress'
import { readEncoding, saveEncoding, forgetEncoding, type Encoding } from './storage/encoding'
import {
  loadReaderWidth,
  saveReaderWidth,
  READER_WIDTH_OPTIONS,
  type ReaderWidth,
} from './storage/reader-width'
import {
  COLOR_THEMES,
  applyTheme,
  loadTheme,
  saveTheme,
  type ColorTheme,
  type Theme,
} from './theme'
import { inTauri } from './tauri'
import './App.css'
import './styles/markdown.css'
import './styles/hljs.css'
import './styles/lightbox.css'
import './styles/findbar.css'
import './styles/diagnostics.css'

/// 侧栏的两种视图：当前文档的大纲、或者打开过的文件夹文件树。
type SidebarTab = 'outline' | 'folder'

/// 与 src-tauri/src/lib.rs 里的 NOT_UTF8 对应。
const NOT_UTF8 = 'ERR_NOT_UTF8'

type Document = {
  name: string
  html: string
  baseDir: string
  /// 阅读位置的存储键：从路径打开是完整路径，从文件选择器打开是 `file:<文件名>`
  source: string
  /// 实际用的编码。非 UTF-8 时在标题栏标出来，让用户知道自己在看什么。
  encoding: Encoding | 'utf-8'
}

/// 错误提示，可以挂一个补救动作 —— 目前只有「按 GBK 打开」一处用到。
type ErrorState = {
  message: string
  action?: { label: string; run: () => void }
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/// md 文件所在目录，用于解析图片的相对路径。
function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : ''
}

/*
 * 替换字符 U+FFFD 占比超过这个比例，就判定「编码猜错了」。
 * 与 lib.rs 里的 REPLACEMENT_RATIO_LIMIT 是同一个判断，改一处要改另一处。
 */
export default function App() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [readerWidth, setReaderWidth] = useState<ReaderWidth>(loadReaderWidth)
  const [doc, setDoc] = useState<Document | null>(null)
  const [error, setError] = useState<ErrorState | null>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [images, setImages] = useState<GalleryImage[]>([])
  const [showOutline, setShowOutline] = useState(true)
  const [folderRoot, setFolderRoot] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('outline')
  const [backToTopVisible, setBackToTopVisible] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  /// 一键诊断面板（Ctrl+Shift+D）：打包后排查 WebView2 行为时用，正常阅读不显示。
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FindResult | null>(null)
  const [matchIndex, setMatchIndex] = useState(0)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)

  const article = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef(0)
  /// 阅读进度条节点：每帧 transform 直接 setProperty，不再走 React state。
  /// 走 React state 会让进度条元素每帧都被 React 重新提交 inline style，
  /// 配合 restore 期的 scroll settle 一连串触发，就是肉眼看见的「抖动」。
  const progressBar = useRef<HTMLDivElement>(null)
  /// 进度数值本身。用 ref 跟踪是为了写进度条时不另起一次 React 重渲染。
  /// 跨 5 % 阈值时才同步到 backToTopVisible（用于 back-to-top 按钮显隐）。
  const progressValue = useRef(0)
  /// 节流：onScroll 里 setActiveId + saveProgress 不每帧跑。
  /// 长 GBK 文档 headings 上百条，每帧遍历 + N 次 getBoundingClientRect 触发 reflow
  /// 是肉眼可见抖动的主源；saveProgress 写 localStorage 是同步 IO，同样该节流。
  const lastScrollUpdate = useRef(0)
  /// 恢复上次位置时要把保存关掉，否则恢复过程本身会把记录刷成 0。
  const restoring = useRef(false)
  /// 查找结果因正文被换掉而重算的次数。设上限是为了：万一真有东西在持续替换
  /// 正文，不能跟着它无限重算。
  const findStaleHeals = useRef(0)

  /*
   * ★ 这是全应用最容易踩的一个坑，改动前务必读完 ★
   *
   * dangerouslySetInnerHTML 的值**必须是同一个对象引用**，不能写成内联字面量。
   *
   * 原因（已核对 react-dom 19.2.8 源码，两处都对上了）：
   *   1. updateProperties 判断是否要更新某个 prop，用的是**对象身份比较**
   *      （源码里就是 `nextProp !== lastProp`），而不是比较 __html 字符串；
   *   2. 一旦判为「变了」，就调 setProp，而 setProp 对 dangerouslySetInnerHTML
   *      是**无条件** `domElement.innerHTML = key;`，内部不再做任何比较。
   *
   * 两件事合起来的后果：写成 `{{ __html: doc.html }}` 时每次渲染都产生一个新对象，
   * 于是**每一次 React 重渲染都会把整篇正文销毁重建一遍**。
   *
   * 这一刀砍掉了三类东西（用户报的三个 bug 全在这儿）：
   *   - 标题的 id（大纲跳转靠它，没了就点不动）
   *   - 复制按钮（命令式挂上去的，被冲掉）
   *   - 查找结果里存的那批文本节点引用（离线后既不着色、量位置也全返回 0）
   * 同时每次重建都触发成片的布局重排 —— 真机实测 213 次布局位移，
   * 就是用户说的「滚到底部会抖」。
   *
   * 用 useMemo 把对象身份钉在 doc.html 上即可：内容没变，引用就不变，
   * React 判定「没变」直接跳过，正文再也不会被重写。
   */
  const articleHtml = useMemo(() => ({ __html: doc?.html ?? '' }), [doc?.html])

  /*
   * 视口宽度震荡监测（诊断用，定位完可整段删）。
   *
   * 滚动条一出现，.content 的可用宽度就少掉十几像素；正文重排变矮后滚动条
   * 又消失，宽度涨回来 —— 循环往复，每循环一次整篇正文完整重排一遍，
   * 而且永不收敛。这是「整个窗口都在抖」最典型的成因，开发环境几乎看不出来。
   * 用 ResizeObserver 盯着可用宽度，跳一次记一次，由诊断面板直接报出来。
   */
  useEffect(() => {
    const container = scroller.current
    if (!container) return
    let last = container.clientWidth
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth
      if (width === last) return
      last = width
      viewportFlips.changes += 1
      viewportFlips.min = Math.min(viewportFlips.min, width)
      viewportFlips.max = Math.max(viewportFlips.max, width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
  }, [theme])

  useEffect(() => {
    saveReaderWidth(readerWidth)
  }, [readerWidth])

  // 双击 .md 文件打开时，路径由 Rust 从命令行参数带过来。
  useEffect(() => {
    if (!inTauri) return
    invoke<string | null>('take_startup_file')
      .then((path) => {
        // 上次如果记了编码就直接带上，别让用户再点一次按钮
        if (path) void openPath(path, readEncoding(path) ?? undefined)
      })
      .catch(() => {
        // 拿不到就算了，用户还能手动打开文件。这里静默失败即可。
      })
  }, [])

  // 图片路径、大纲、图片清单、阅读位置都必须在 innerHTML 落地之后处理。
  useEffect(() => {
    const container = scroller.current

    /*
     * 执行痕迹：只记几个计数，不改变任何行为。
     *
     * 这段代码曾几何时在真机上「看起来没生效」——大纲的 id 一个都找不到、
     * 复制按钮一个都没挂上，但 jsdom 里跑同样的逻辑 100% 正常。
     * 最后查出是 React 19 每次重渲染都重写了整篇正文（见上面 articleHtml 的注释），
     * 与这段代码本身无关。病根已除，这里只留一组计数器，
     * 供诊断面板确认它跑过、跑到哪一步。
     */
    const trace = {
      guardDoc: !!doc,
      guardArticle: !!article.current,
      guardContainer: !!container,
      reachedInstall: false,
      headings: 0,
      buttonsAtInstall: 0,
      cleanedUp: false,
    }
    ;(window as unknown as Record<string, unknown>).__mdReaderTrace = trace

    if (!doc || !article.current || !container) return

    const articleEl = article.current

    if (inTauri) resolveImages(articleEl, doc.baseDir)

    // 复制按钮也是后置的：DOMPurify 不会让按钮跟着 markdown 一起过清洗，
    // 所以得在 sanitize 之后命令式地给 pre / table 挂上去。
    const collected = collectHeadings(articleEl)
    trace.reachedInstall = true
    trace.headings = collected.length
    setHeadings(collected)

    // 在 resolveImages 之后收集：这时拿到的是转换好的 asset 地址，
    // 直接喂给灯箱就能用。
    setImages(
      [...articleEl.querySelectorAll('img')].map((img) => {
        const src = img.getAttribute('src') ?? ''
        return { src, name: img.getAttribute('alt') || fileName(src) }
      }),
    )

    const teardownButtons = installCopyButtons(articleEl, {
      copyLabel: t('copy.code'),
      copiedLabel: t('copy.copied'),
    })
    trace.buttonsAtInstall = articleEl.querySelectorAll('.md-copy-btn').length

    const saved = readProgress(doc.source)
    const scrollable = container.scrollHeight - container.clientHeight
    if (saved !== null && scrollable > 0) {
      restoring.current = true
      container.scrollTop = saved * scrollable
      // 等 restore 落定后（即下一帧）才同步进度条。
      // 在这之前任何对 progress 的写入都会被这个 scroll 事件顺势再触发 onScroll 回写，
      // 整条链路在 restore 期内反复跑就会被肉眼识别成「抖动」。
      requestAnimationFrame(() => {
        restoring.current = false
        writeProgress(saved)
      })
    } else {
      // 新文件直接清零（第一次打开或换了文件）
      restoring.current = false
      writeProgress(0)
    }

    /*
     * teardown 用局部变量，不再挂在共享 ref 上。
     * 共享 ref 会被后一次 effect 覆写，一旦 cleanup 与 install 的时序交错
     * （换文档足够快时就会），后一次的 cleanup 会顺手把刚装好的按钮删掉，
     * 表现为「一个按钮都不剩」。局部变量的 cleanup 只拆自己装的那一批。
     */
    return () => {
      trace.cleanedUp = true
      teardownButtons()
    }
  }, [doc])

  /*
   * 查找：只扫偏移，不建 Range（这一步是毫秒级的，见 find/index.ts 的说明）。
   * Range 昂贵，留给真正要上色时按需建。
   */
  useEffect(() => {
    if (!findOpen || !article.current || !query) {
      clearHighlights()
      setResult(null)
      setMatchIndex(0)
      return
    }

    const found = findOffsets(article.current, query, { caseSensitive, wholeWord })
    setResult(found)
    setMatchIndex(0)

    if (found.offsets.length > 0 && scroller.current) {
      const first = rangeAt(found, 0)
      if (first) scrollToRange(first, scroller.current)
    }
  }, [findOpen, query, caseSensitive, wholeWord, doc])

  // 上色：只给视口附近的匹配建 Range。滚动时再由 onScroll 里的 rAF 补上。
  useEffect(() => {
    const container = scroller.current
    if (!findOpen || !result || !container) {
      clearHighlights()
      return
    }
    /*
     * 自愈（v0.2.8）：正文被换掉之后，result 里存的那批文本节点会脱离文档，
     * 建出来的 Range 有两大后果 —— 既不着色，getBoundingClientRect 也全返回 0
     * （跳转位置按 0 去算，就是用户说的「上下翻不对」）。
     * 检测到就照着当前正文重算一次。
     */
    if (!isFresh(result) && article.current && findStaleHeals.current < 5) {
      findStaleHeals.current += 1
      findTrace.staleHeals += 1
      setResult(findOffsets(article.current, query, { caseSensitive, wholeWord }))
      setMatchIndex(0)
      return
    }

    paintHighlights(result, container, matchIndex)
  }, [findOpen, result, matchIndex, query, caseSensitive, wholeWord])

  // 关闭查找或组件卸载时把高亮撤掉，不留残余样式。
  useEffect(() => {
    if (!findOpen) clearHighlights()
  }, [findOpen])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      // Ctrl+Shift+D 必须排在 Ctrl+D 之前：后者只比 key === 'd'，
      // 会把带 Shift 的组合一并吃掉。
      if (mod && event.shiftKey && key === 'd') {
        event.preventDefault()
        setShowDiagnostics((visible) => !visible)
        return
      }

      if (mod && key === 'd') {
        event.preventDefault()
        setShowOutline((visible) => !visible)
        return
      }

      if (mod && key === 'f') {
        event.preventDefault()
        setFindOpen(true)
        return
      }

      if (event.key === 'Escape') {
        // 灯箱在最上层，先关它
        if (lightboxIndex !== null) setLightboxIndex(null)
        else if (findOpen) setFindOpen(false)
        return
      }

      if (mod && key === 'g' && findOpen) {
        event.preventDefault()
        gotoMatch(event.shiftKey ? -1 : 1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [findOpen, lightboxIndex, result, matchIndex])

  async function show(
    name: string,
    markdown: string,
    baseDir: string,
    source: string,
    encoding: Encoding | 'utf-8',
  ) {
    // 先把冷门语言补注册再渲染，否则这些代码块会退化成纯文本。
    // 常用语言已在模块加载时注册，这里通常一次 await 都不需要真正发请求。
    await ensureLanguages(detectCodeLanguages(markdown))
    setDoc({ name, html: renderMarkdown(markdown), baseDir, source, encoding })
    setError(null)
    if (inTauri) void getCurrentWindow().setTitle(`${name} — ${t('app.title')}`)
  }

  /*
   * 从路径打开文件。
   *
   * encoding 为空表示按 UTF-8 读。非 UTF-8 时不猜、不降级，直接报错并把
   * 「按 GBK 打开」的入口交给用户 —— 自动猜测容易把一份文件解成谁也认不出的
   * 样子，而用户点一下按钮的代价很小，且选择会被记住。
   */
  async function openPath(path: string, encoding?: Encoding) {
    try {
      const text = encoding
        ? await invoke<string>('read_file_as', { path, encoding })
        : await invoke<string>('read_markdown_file', { path })
      await show(fileName(path), text, dirName(path), path, encoding ?? 'utf-8')
    } catch (err) {
      const message = String(err)
      if (message !== NOT_UTF8) {
        setError({ message: t('status.readFailed', { message }) })
        return
      }

      // 已经指定过 GBK 还失败，说明这文件既不是 UTF-8 也不是 GBK。
      // 顺手忘掉这条记忆：留着它，下次打开还会走同一条死路。
      if (encoding) {
        forgetEncoding(path)
        setError({ message: t('status.decodeFailed') })
        return
      }

      setError({
        message: t('status.notUtf8'),
        action: {
          label: t('status.openAsGbk'),
          run: () => {
            saveEncoding(path, 'gbk')
            void openPath(path, 'gbk')
          },
        },
      })
    }
  }

  /// 滚动回调很密集，用 rAF 合并：一帧最多算一次。
  /// 进度条直写 transform 也每帧做（成本是 1 个 GPU 合成，便宜）。
  /// 但 setActiveId + saveProgress 都节流到 50ms 一次：
  ///   长 GBK 文档的 headings 上百条，findActiveHeading 每帧遍历触发 N 次 reflow
  ///   会被肉眼识别成「抖动」；saveProgress 写 localStorage 是同步 IO，
  ///   同样不该每帧跑。
  function onScroll() {
    const container = scroller.current
    if (!container || restoring.current) return
    cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      const scrollable = container.scrollHeight - container.clientHeight
      const percent = scrollable > 0 ? container.scrollTop / scrollable : 0
      writeProgress(percent)

      const now = performance.now()
      if (now - lastScrollUpdate.current > 50) {
        lastScrollUpdate.current = now
        setActiveId(findActiveHeading(headings, container))
        if (doc) saveProgress(doc.source, percent)
      }

      // 视口变了，可见的高亮范围也跟着变。只重建视口内的 Range，很便宜。
      if (findOpen && result) paintHighlights(result, container, matchIndex)
    })
  }

  /*
   * 把进度同步到进度条（DOM 直写）与 back-to-top 的显隐（React state）。
   *
   * 进度条本身每帧由 rAF 推进，但 React state 一秒最多改两三次（跨阈值时），
   * 不会变成节拍器。restore 期内调它要慎重 —— 让 rAF 里 progressValue 重置后
   * 跨阈值判断走的是「restore 之前那一刻的 value」，视觉效果是恢复完成后
   * 才闪一下，符合「恢复之前 keep silent」的目标。
   */
  function writeProgress(percent: number) {
    // 直写 transform：进度条不再挂 React state，节拍彻底消除。
    if (progressBar.current) {
      progressBar.current.style.transform = `scaleX(${percent})`
    }
    const wasVisible = progressValue.current > 0.05
    progressValue.current = percent
    const nowVisible = percent > 0.05
    if (wasVisible !== nowVisible) setBackToTopVisible(nowVisible)
  }

  function goToHeading(id: string) {
    const container = scroller.current
    const target = document.getElementById(id)
    if (!container || !target) return
    container.scrollTo({
      // 用两者的 rect 差值算，不依赖 offsetTop（那要求容器恰好是 offsetParent）
      top:
        container.scrollTop +
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top,
      behavior: 'smooth',
    })
  }

  function gotoMatch(delta: number) {
    const container = scroller.current
    if (!container) return

    /*
     * 正文被换掉后旧 chunks 是离线节点，rangeAt 量出来全是 0，跳转必偏。
     * 这里就地重算一份再跳，不等上面那个 effect —— 否则用户按第一下没反应、
     * 第二下才动，体感更怪。
     */
    let target = result
    if (target && !isFresh(target) && article.current) {
      target = findOffsets(article.current, query, { caseSensitive, wholeWord })
      findTrace.staleHeals += 1
      setResult(target)
    }

    if (!target || target.offsets.length === 0) return
    const total = target.offsets.length
    const next = (((matchIndex + delta) % total) + total) % total
    setMatchIndex(next)

    const range = rangeAt(target, next)
    if (range) scrollToRange(range, container)
    // 跳转后视口会变，滚动事件会触发补色；这里先补一次，
    // 以免平滑滚动尚未开始时有一帧没高亮。
    paintHighlights(target, container, next)
  }

  function onContentClick(event: React.MouseEvent) {
    const target = event.target as HTMLElement

    if (target.tagName === 'IMG' && article.current) {
      const list = [...article.current.querySelectorAll('img')]
      const index = list.indexOf(target as HTMLImageElement)
      if (index >= 0) setLightboxIndex(index)
      return
    }

    const link = target.closest('a')
    if (!link) return

    // 浏览器里调试时不拦，让链接正常跳，方便验证 href 本身对不对
    if (!inTauri) return
    // 页内锚点交给浏览器：标题 id 由 headings.ts 生成，浏览器自己会滚过去
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) return

    // 其余一律拦下。不拦的话 WebView2 会整体导航走，阅读器当场变成浏览器，
    // 连当前文档一起丢掉 —— 这是打开别人给的 md 时最容易撞上的坑。
    event.preventDefault()
    if (/^(https?|mailto):/i.test(href)) void openUrl(href)
    // 其余协议（file: 等）不在 opener 的权限范围内，静默忽略，
    // 至少不会把整个界面导航走。
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="doc-name">
          {doc?.name ?? t('app.title')}
          {/* 非 UTF-8 时标出来：用户该知道自己在看一份转码过的文件 */}
          {doc && doc.encoding !== 'utf-8' && (
            <span className="doc-encoding">{doc.encoding.toUpperCase()}</span>
          )}
        </span>

        <div className="controls">
          <button
            onClick={async () => {
              /*
               * 用 Tauri 的对话框而不是 <input type="file">。
               *
               * 后者拿不到完整路径：浏览器安全模型把 webview 里的 file 控件收成了
               * 只能取文件名，调用 baseDir 永远是空串，相对路径图片（![样例](sample-image.svg)）
               * 全部解析失败。这正是 v0.2 安装包里「样例图片没打开」的根因。
               *
               * Tauri dialog 直接调操作系统原生的 OpenFileDialog，把完整路径
               * 字符串交给前端，与 openPath() 完全契合。
               */
              if (!inTauri) return
              const picked = await openDialog({
                multiple: false,
                filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
              })
              if (typeof picked === 'string') void openPath(picked, readEncoding(picked) ?? undefined)
            }}
          >
            {t('toolbar.openFile')}
          </button>

          <button
            onClick={async () => {
              if (!inTauri) return
              const picked = await openDialog({ directory: true, multiple: false })
              if (typeof picked === 'string') {
                setFolderRoot(picked)
                setSidebarTab('folder')
              }
            }}
          >
            {t('toolbar.openFolder')}
          </button>

          <label>
            {t('toolbar.colorTheme')}
            <select
              value={theme.color}
              onChange={(e) =>
                setTheme({ ...theme, color: e.currentTarget.value as ColorTheme })
              }
            >
              {COLOR_THEMES.map((color) => (
                <option key={color} value={color}>
                  {t(`theme.${color}`)}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t('toolbar.readerWidth')}
            <select
              value={readerWidth}
              onChange={(e) =>
                setReaderWidth(Number(e.currentTarget.value) as ReaderWidth)
              }
            >
              {READER_WIDTH_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {t('toolbar.readerWidthPercent', { percent: value })}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() =>
              setTheme({ ...theme, scheme: theme.scheme === 'light' ? 'dark' : 'light' })
            }
          >
            {theme.scheme === 'light' ? t('scheme.dark') : t('scheme.light')}
          </button>

          <label>
            {t('toolbar.language')}
            <select value={i18n.language} onChange={(e) => setLang(e.currentTarget.value as Lang)}>
              {LANGS.map((lang) => (
                <option key={lang} value={lang}>
                  {t(`language.${lang}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {findOpen && (
        <FindBar
          query={query}
          onQuery={setQuery}
          matchCount={result?.offsets.length ?? 0}
          currentIndex={matchIndex}
          caseSensitive={caseSensitive}
          wholeWord={wholeWord}
          onToggleCase={() => setCaseSensitive((value) => !value)}
          onToggleWord={() => setWholeWord((value) => !value)}
          onNext={() => gotoMatch(1)}
          onPrevious={() => gotoMatch(-1)}
          onClose={() => setFindOpen(false)}
        />
      )}

      <div className="body">
        {/* 进度条横跨整个内容区顶部，所以放在 .body 下而不是滚动容器里 */}
        <div className="progress-track">
          <div className="progress-bar" ref={progressBar} />
        </div>

        {(showOutline || folderRoot) && (
          <aside className="sidebar">
            {/*
             * 侧栏有两个 tab：大纲看当前文档结构，文件夹看打开过的目录文件清单。
             * 都用按钮呈现而不是路由：v0.3 体量太小了，引一个 router 不划算。
             *
             * 切换只影响哪一块可见，状态各自保留 —— 切回大纲时滚动位置、折叠
             * 状态都还在；切到文件夹再切回来时不需要重新调用 collectHeadings。
             */}
            <div className="sidebar-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={sidebarTab === 'outline'}
                className={`sidebar-tab ${sidebarTab === 'outline' ? 'active' : ''}`}
                onClick={() => setSidebarTab('outline')}
              >
                {t('sidebar.outline')}
              </button>
              <button
                role="tab"
                aria-selected={sidebarTab === 'folder'}
                className={`sidebar-tab ${sidebarTab === 'folder' ? 'active' : ''}`}
                onClick={() => setSidebarTab('folder')}
              >
                {t('sidebar.folder')}
              </button>
            </div>

            {/*
             * 两块都用 display:none 隐藏而不是卸载：切回来时不必再花 IO 拉一遍
             * 列表，也不必重做 Outline 的折叠/高亮状态。视口外的节点本就不参与
             * 重排，DOM 在那也只是占几行文本节点，无所谓。
             */}
            <div className="sidebar-pane" hidden={sidebarTab !== 'outline'}>
              {doc && showOutline && (
                <Outline headings={headings} activeId={activeId} onSelect={goToHeading} />
              )}
            </div>
            <div className="sidebar-pane" hidden={sidebarTab !== 'folder'}>
              <FileTree
                root={folderRoot}
                currentSource={doc?.source ?? null}
                onSelect={(path) => void openPath(path, readEncoding(path) ?? undefined)}
              />
            </div>
          </aside>
        )}

        <div
          className="content"
          ref={scroller}
          onScroll={onScroll}
          onClick={onContentClick}
          style={{ ['--reader-width' as string]: `${readerWidth}%` }}
        >
          {error && (
            <div className="error">
              <span>{error.message}</span>
              {error.action && (
                <button className="error-action" onClick={error.action.run}>
                  {error.action.label}
                </button>
              )}
            </div>
          )}

          {doc ? (
            <article
              ref={article}
              className="markdown-body"
              dangerouslySetInnerHTML={articleHtml}
            />
          ) : (
            <div className="empty">
              <h1>{t('empty.title')}</h1>
              <p>{t('empty.hint')}</p>
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        className={`back-to-top${backToTopVisible ? ' visible' : ''}`}
        onClick={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        {t('action.backToTop')}
      </button>

      {lightboxIndex !== null && images[lightboxIndex] && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}

      {showDiagnostics && (
        <>
          <div
            className="diagnostics-backdrop"
            onClick={() => setShowDiagnostics(false)}
          />
          <Diagnostics onClose={() => setShowDiagnostics(false)} />
        </>
      )}
    </div>
  )
}
