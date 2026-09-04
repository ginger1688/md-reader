import { useEffect, useState } from 'react'
import { findTrace } from '../find'

/*
 * 一键诊断面板（Ctrl+Shift+D 开关）。
 *
 * 存在的理由：打包后的 Tauri 应用里，WebView2 的不少行为在开发环境复现不出来
 * —— asset 协议给 .svg 的 Content-Type 到底是什么、CSS Custom Highlight API
 * 在这个 WebView2 版本上支不支持、大纲里的 id 与正文元素对不对得上，
 * 全得在真机上才知道。
 *
 * 与其让使用者去开 DevTools 翻 Network / Console（对非开发者门槛太高），
 * 不如把这几项检查做进应用里：按一个键，结果直接列出来，还能一键复制成
 * 纯文本报告贴回来分析。
 *
 * 这里刻意不接 i18n：它是排障工具，不是面向读者的功能。中文直写能让报告在
 * 任何语言设置下都保持同一份措辞，便于多次比对。
 */

type Status = 'ok' | 'warn' | 'fail'

type Check = {
  label: string
  status: Status
  detail: string
}

const STATUS_MARK: Record<Status, string> = {
  ok: '正常',
  warn: '注意',
  fail: '异常',
}

/*
 * 抖动量化（常驻监听，模块一加载就开始累计）。
 *
 * 「滚到底部会抖」这句话没法定位——必须知道**是哪个元素**在动、动了多大。
 * PerformanceObserver 的 layout-shift 条目自带 sources，直接给出位移的节点。
 *
 * 放在模块顶层而不是面板里启动，是因为用户是「先滚动（面板关着）、再开面板看
 * 数字」；等开面板才监听就什么都抓不到了。buffered: true 可以把开面板之前的
 * 记录一并取回来。hadRecentInput 的条目要滤掉——那是用户自己在点/滚，不算 bug。
 */
type ShiftEntry = PerformanceEntry & {
  value: number
  hadRecentInput: boolean
  sources?: { node?: Node | null }[]
}

const shifts = { score: 0, count: 0, worst: 0, sources: new Map<string, number>() }

/*
 * 滚动容器的可用宽度震荡计数（由 App.tsx 用 ResizeObserver 写入，这里只读）。
 *
 * 「整个窗口都在抖」最典型的成因是滚动条震荡：滚动条一出现，可用宽度就少掉
 * 十几像素，正文重排后总高度变矮，滚动条又不需要了……如此往复，每循环一次
 * 整篇正文完整重排一遍，而且永不收敛。
 *
 * 判据很直接：可用宽度如果只在两个相差约一个滚动条宽度（≈15px）的值之间跳，
 * 那几乎可以断定就是它。
 */
export const viewportFlips = { changes: 0, min: Number.POSITIVE_INFINITY, max: 0 }

function describeNode(node: Node): string {
  const element = node as Element
  const tag = String(element.tagName ?? '?').toLowerCase()
  const cls =
    typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/u)[0]}`
      : ''
  return `${tag}${cls}`
}

if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as ShiftEntry[]) {
        if (entry.hadRecentInput) continue
        shifts.score += entry.value
        shifts.count += 1
        if (entry.value > shifts.worst) shifts.worst = entry.value
        for (const source of entry.sources ?? []) {
          if (!source.node) continue
          const key = describeNode(source.node)
          shifts.sources.set(key, (shifts.sources.get(key) ?? 0) + 1)
        }
      }
    }).observe({ type: 'layout-shift', buffered: true })
  } catch {
    // 这个 WebView2 不支持 layout-shift 就算了，其余检查照跑
  }
}

/**
 * 抖动结论。阈值取 Chrome 官方 CLS 的「良好 / 需改进」分界：0.02 / 0.1。
 * 用法：**先滚动文档，再开面板**——数字是开机以来累计的，不是开面板那一刻的。
 */
function readLayoutShift(): Check {
  const top = [...shifts.sources.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => `${name} ×${n}`)
    .join('、')

  if (shifts.count === 0) {
    return {
      label: '页面抖动量化',
      status: 'ok',
      detail: '本次运行没记到任何布局位移（若你开面板前已经滚过文档，说明确实没抖）',
    }
  }

  return {
    label: '页面抖动量化',
    status: shifts.score > 0.1 ? 'fail' : shifts.score > 0.02 ? 'warn' : 'ok',
    detail:
      `累计位移 ${shifts.score.toFixed(4)}（${shifts.count} 次，最大单次 ${shifts.worst.toFixed(4)}）；` +
      `位移最多的元素：${top || '（浏览器没给出来源节点）'}`,
  }
}

/*
 * 探测一个图片地址：除了 Content-Type，还把返回内容的开头取回来。
 *
 * 只看 Content-Type 不够 —— 实测发现 SVG 报的是正确的 image/svg+xml，
 * 浏览器却解码失败。这时真正要紧的是「实际收到了什么」：
 * 开头是 `<?xml` / `<svg` 才是真图；若是 `<!DOCTYPE html>` 就说明
 * 服务器返回的是 HTML 错误页，而 Content-Type 在撒谎。
 */
type ProbeResult = { type: string; head: string; bytes: number }

async function probeImage(src: string): Promise<ProbeResult> {
  try {
    const response = await fetch(src, { method: 'GET' })
    if (!response.ok) return { type: `HTTP ${response.status}`, head: '', bytes: 0 }
    const type = response.headers.get('content-type') ?? '(响应头里没有 content-type)'
    const text = await response.text()
    return {
      type,
      // 前 40 个字符足够分辨文件类型了，压缩掉空白免得刷屏
      head: text.slice(0, 40).replace(/\s+/gu, ' '),
      bytes: text.length,
    }
  } catch (error) {
    return { type: `请求失败：${String(error)}`, head: '', bytes: 0 }
  }
}

function readEnvironment(): Check {
  // WebView2 的 UA 里带 Edg/<版本>；普通 Chrome 只有 Chrome/<版本>
  const edge = /Edg\/([\d.]+)/.exec(navigator.userAgent)
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)
  const version = edge?.[1] ?? chrome?.[1] ?? '未知'
  return {
    label: '运行环境',
    status: edge ? 'ok' : 'warn',
    detail: `WebView2 ${version}${edge ? '' : '（UA 里没找到 Edg，可能不在 WebView2 中）'}`,
  }
}

function readDocumentStats(): Check {
  const article = document.querySelector('.markdown-body')
  const images = article?.querySelectorAll('img').length ?? 0
  const headings = article?.querySelectorAll('h1,h2,h3,h4,h5,h6').length ?? 0
  const pres = article?.querySelectorAll('pre').length ?? 0
  const tables = article?.querySelectorAll('table').length ?? 0
  const copyButtons = document.querySelectorAll('.md-copy-btn').length
  const expected = pres + tables
  return {
    label: '当前文档统计',
    status: copyButtons === expected ? 'ok' : 'warn',
    detail:
      `图片 ${images} 张 / 标题 ${headings} 个 / 代码块 ${pres} 个 / 表格 ${tables} 个；` +
      `复制按钮已挂载 ${copyButtons} 个（预期 ${expected} 个）`,
  }
}

function readHighlightApi(): Check {
  const supported =
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof CSS.highlights?.set === 'function'
  return {
    label: '查找高亮（CSS Custom Highlight API）',
    status: supported ? 'ok' : 'fail',
    detail: supported
      ? '支持 —— 查找高亮应能正常显示'
      : '不支持 —— 查找高亮必须回退到 <mark> 包裹方案',
  }
}

function readOutlineIds(): Check {
  const items = Array.from(document.querySelectorAll('.outline-item'))
  if (items.length === 0) {
    return {
      label: '大纲标题 id 匹配',
      status: 'warn',
      detail: '大纲为空 —— 当前文档可能没有标题，或侧栏没打开',
    }
  }
  const missing: string[] = []
  for (const item of items) {
    const id = item.getAttribute('data-id')
    if (id && !document.getElementById(id)) missing.push(id)
  }
  return {
    label: '大纲标题 id 匹配',
    status: missing.length === 0 ? 'ok' : 'fail',
    detail:
      missing.length === 0
        ? `${items.length} 个标题全部能在正文找到对应元素`
        : `${missing.length}/${items.length} 个找不到对应元素：` +
          `${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}`,
  }
}

function readReaderWidth(): Check {
  const body = document.querySelector('.markdown-body') as HTMLElement | null
  const content = document.querySelector('.content') as HTMLElement | null
  if (!body || !content) {
    return { label: '阅读宽度', status: 'warn', detail: '没找到内容区，可能还没打开文档' }
  }
  const style = getComputedStyle(content)
  const variable = style.getPropertyValue('--reader-width').trim()
  const bodyWidth = Math.round(body.getBoundingClientRect().width)
  // clientWidth 含左右内边距，直接除会白白少算十几个百分点
  // （实测 481/545 = 88%，扣掉 32×2 的内边距后其实是 100%）。
  const padding =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  const available = content.clientWidth - padding
  const filled = available > 0 ? Math.round((bodyWidth / available) * 100) : 0
  return {
    label: '阅读宽度',
    status: 'ok',
    detail:
      `--reader-width = ${variable || '(未设置)'}；` +
      `正文实际 ${bodyWidth}px / 可用 ${available}px（占 ${filled}%）`,
  }
}

/*
 * 读取 App.tsx 那段初始化代码留下的执行痕迹。
 *
 * 这是最直接的一手证据：DOM 查询只能看到「结果」（按钮 0 个、id 找不到），
 * 而痕迹能回答「过程」—— 那段代码到底跑没跑、跑到哪一步、装完之后有没有被拆掉。
 * 有了它就不用再靠推测。
 */
function readEffectTrace(): Check {
  const trace = (window as unknown as Record<string, unknown>).__mdReaderTrace as
    | {
        guardDoc?: boolean
        guardArticle?: boolean
        guardContainer?: boolean
        reachedInstall?: boolean
        headings?: number
        buttonsAtInstall?: number
        cleanedUp?: boolean
        healCount?: number
        healReason?: string
        markSurvived?: boolean | null
        contentWrites?: number
        writeStacks?: string[]
      }
    | undefined

  if (!trace) {
    return {
      label: '初始化执行痕迹（决定性）',
      status: 'fail',
      detail: '一段记录都没有 —— 那段初始化代码一次都没执行过',
    }
  }

  const passed = Boolean(trace.guardDoc && trace.guardArticle && trace.guardContainer)
  const detail = [
    passed
      ? '三个前置条件都满足，代码继续往下跑了'
      : `被前置条件挡住了（doc=${trace.guardDoc} / 内容区 ref=${trace.guardArticle} / 滚动容器 ref=${trace.guardContainer}）`,
    `初始化：${trace.reachedInstall ? `跑了，标题 ${trace.headings} 条、当时装了 ${trace.buttonsAtInstall} 个按钮` : '没跑到'}`,
    `之后被拆掉：${trace.cleanedUp ? '是 —— 这就是按钮一个不剩的直接原因' : '否'}`,
    (trace.healCount ?? 0) > 0
      ? `内容被换掉后自动补回 ${trace.healCount} 次（判定原因：${trace.healReason}）`
      : '内容被换掉后自动补回：0 次',
    trace.markSurvived === null
      ? '节点标记：没触发过补回，无从判断'
      : trace.markSurvived
        ? '节点标记还在 —— 是同一个节点的内容被重写了'
        : '节点标记没了 —— 整个节点被换掉了',
    (trace.contentWrites ?? 0) === 0
      ? '内容写入：初始化之后一次都没被重写过'
      : `内容写入：之后被重写了 ${trace.contentWrites} 次`,
    ...(trace.writeStacks ?? []).map((stack) => `写入来源：${stack}`),
  ].join('；')

  /*
   * 补回过（healCount > 0）算 warn 而不是 ok：功能虽然被救回来了，
   * 但说明仍有东西在反复冲掉正文，值得继续追。
   */
  const status: Status =
    !passed || !trace.reachedInstall || trace.cleanedUp
      ? 'fail'
      : (trace.healCount ?? 0) > 0 || (trace.contentWrites ?? 0) > 0
        ? 'warn'
        : 'ok'

  return { label: '初始化执行痕迹（决定性）', status, detail }
}

/*
 * 判决用：区分「effect 压根没跑」「跑了但只跑一半」「跑完了但节点被换掉」。
 *
 * 这三项在外部看起来都是「大纲不跳 + 复制按钮没有」，但根因完全不同：
 *   ① 标题带 id 0 个 + 按钮宿主 0 个  → effect 整体没执行（article ref 为空或提前 return）
 *   ② 标题带 id 21 个 + 按钮宿主 0 个 → collectHeadings 跑了但 installCopyButtons 没跑
 *   ③ 标题带 id 21 个 + 按钮宿主 9 个 → 都跑完了，说明存在两个 .markdown-body，
 *      操作落在一个节点上、查询落在另一个节点上
 * 只看症状无法区分，所以把中间量全部摊出来。
 */
function readDomConsistency(): Check {
  const bodies = document.querySelectorAll('.markdown-body')
  const article = bodies[0] as HTMLElement | null
  if (!article) {
    return { label: 'DOM 一致性（判决用）', status: 'fail', detail: '找不到 .markdown-body' }
  }

  const inTree = document.body.contains(article)
  const titles = Array.from(article.querySelectorAll('h1,h2,h3,h4,h5,h6'))
  const withId = titles.filter((title) => (title as HTMLElement).id !== '').length
  const hosts = article.querySelectorAll('.md-copy-host').length
  const pres = article.querySelectorAll('pre').length
  const tables = article.querySelectorAll('table').length

  let status: Status = 'ok'
  if (withId === 0 && hosts === 0) status = 'fail'
  else if (hosts < pres + tables) status = 'fail'
  if (bodies.length > 1 || !inTree) status = 'fail'

  return {
    label: 'DOM 一致性（判决用）',
    status,
    detail:
      `.markdown-body ${bodies.length} 个；在文档树中：${inTree ? '是' : '否'}；` +
      `标题 ${titles.length} 个（带 id ${withId} 个）；` +
      `按钮宿主 ${hosts} 个（代码块 ${pres} + 表格 ${tables}，预期 ${pres + tables}）`,
  }
}

/*
 * 查找高亮的现状：规则有没有注入 + 当前注册了几组高亮。
 *
 * 分两项看是因为它们会分别坏：规则由 applyTheme 注入（缺了就是完全不着色），
 * 高亮由 paintHighlights 注册（开着查找时才有）。
 * 想查「查找为什么不高亮」，要**先按 Ctrl+F 打开查找栏并输入关键词**，
 * 再按 Ctrl+Shift+D —— 那时这里应该显示「已注册 2 组」，否则就是没上色。
 */
function readFindState(): Check {
  const styleText =
    document.getElementById('find-highlight-style')?.textContent ?? ''
  const hasRule = styleText.includes('md-reader-find')
  const registered =
    typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights.size : -1

  return {
    label: '查找高亮现状',
    status: hasRule ? 'ok' : 'fail',
    detail:
      `::highlight 规则${hasRule ? '已注入' : '缺失（查找必然不着色）'}；` +
      `当前已注册 ${registered} 组高亮（打开查找并输入关键词后应为 2，没开查找时为 0）`,
  }
}

/*
 * 查找痕迹：**跨查找会话存活**，关掉查找栏之后再来开面板也看得到。
 *
 * 查「查找为什么不高亮 / 上下翻为什么不对」主要靠这一项，
 * 而且它不要求用户开着查找栏 —— 用户往往是关掉之后才想起来开面板，
 * 那时 React 状态早就没了，只有模块级的 findTrace 还记得上一次发生了什么。
 *
 * 「正文被换掉后重算 N 次」这一句是独立证据：大于 0 就说明正文确实被换过，
 * 与初始化痕迹那边的「内容写入」互为印证。
 */
function readFindTrace(): Check {
  const detail = [
    `Highlight API：${findTrace.supported ? '支持' : '不支持 —— 必须回退 <mark> 方案'}`,
    `最近一次搜索：摊平 ${findTrace.lastChunks} 个文本节点，命中 ${findTrace.lastOffsets} 处`,
    `上色执行 ${findTrace.paintCalls} 次，最后注册全套 ${findTrace.registeredAll} 个 / 当前项 ${findTrace.registeredCurrent} 个`,
    `正文被换掉后重算 ${findTrace.staleHeals} 次`,
    findTrace.lastError ? `最近一次异常：${findTrace.lastError}` : '',
  ]
    .filter(Boolean)
    .join('；')

  return {
    label: '查找痕迹（跨会话）',
    status: !findTrace.supported || findTrace.lastError ? 'fail' : 'ok',
    detail,
  }
}

/**
 * 滚动容器的可用宽度稳不稳。宽度每变一次，整篇正文就要重排一次。
 */
function readViewportStability(): Check {
  const { changes, min, max } = viewportFlips
  if (changes === 0) {
    return {
      label: '滚动容器宽度稳定性',
      status: 'ok',
      detail: '可用宽度一次都没变过（滚动条没有反复出没）',
    }
  }

  const gap = max - min
  return {
    label: '滚动容器宽度稳定性',
    status: gap >= 8 ? 'fail' : 'warn',
    detail:
      `可用宽度变了 ${changes} 次，在 ${min}px ~ ${max}px 之间跳动（相差 ${gap}px）；` +
      (gap >= 8
        ? '差值已接近一个滚动条的宽度，基本可以断定是滚动条在反复出现/消失'
        : '差值不大，可能是正常的窗口缩放'),
  }
}

async function readImages(): Promise<Check[]> {
  const images = Array.from(
    document.querySelectorAll('.markdown-body img'),
  ) as HTMLImageElement[]
  if (images.length === 0) {
    return [{ label: '图片加载', status: 'warn', detail: '当前文档没有图片，无法检测' }]
  }

  // 一次最多探 8 张：再多既慢又刷屏，够定位问题了
  const targets = images.slice(0, 8)
  const probes = await Promise.all(
    targets.map(async (img, index) => {
      const src = img.getAttribute('src') ?? ''
      const name = img.getAttribute('alt') || src.split(/[\\/]/).pop() || `第 ${index + 1} 张`
      const probe = await probeImage(src)

      /*
       * 三态判断，不能只看 naturalWidth —— 图片还在传输时它也是 0，
       * 直接判「渲染失败」会误报。img.complete 才是「加载已结束」的可靠标志。
       */
      let state: string
      let imageStatus: Status
      if (!img.complete) {
        imageStatus = 'warn'
        state = '仍在加载中（还没就绪，不能判定为失败）'
      } else if (img.naturalWidth > 0) {
        imageStatus = 'ok'
        state = `已解码 ${img.naturalWidth}×${img.naturalHeight}`
      } else {
        imageStatus = 'fail'
        state = '加载失败（拿到数据但没解码成图片）'
      }

      const notImage = !probe.type.startsWith('image/')
      // 内容嗅探：真 SVG 开头应是 <?xml 或 <svg；拿到 <!DOCTYPE 说明是 HTML 页面
      const looksHtml = /^<!doctype|<html/i.test(probe.head)

      return {
        label: `图片 ${index + 1}：${String(name).slice(0, 40)}`,
        status: notImage || looksHtml ? 'fail' : imageStatus,
        detail:
          `Content-Type = ${probe.type}；${state}；` +
          `实际收到 ${probe.bytes} 字节，开头是「${probe.head || '(空)'}」` +
          (looksHtml ? ' ← 这是 HTML 页面而不是图片，说明请求根本没拿到图片文件' : '') +
          (notImage ? '（声明的也不是图片类型）' : ''),
      }
    }),
  )

  if (images.length > targets.length) {
    probes.push({
      label: '图片加载',
      status: 'warn',
      detail: `文档共 ${images.length} 张图，这里只探测了前 ${targets.length} 张`,
    })
  }
  return probes
}

export function Diagnostics({ onClose }: { onClose: () => void }) {
  const [checks, setChecks] = useState<Check[]>([])
  const [probing, setProbing] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // 组件可能在 fetch 返回前就被关掉，用 alive 挡住迟到的 setState
    let alive = true
    void (async () => {
      const base = [
        readEnvironment(),
        readEffectTrace(),
        readDocumentStats(),
        readDomConsistency(),
        readHighlightApi(),
        readFindState(),
        readFindTrace(),
        readOutlineIds(),
        readReaderWidth(),
        readLayoutShift(),
        readViewportStability(),
      ]
      if (alive) setChecks(base)
      const imageChecks = await readImages()
      if (alive) {
        setChecks([...base, ...imageChecks])
        setProbing(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const report = checks
    .map((check) => `[${STATUS_MARK[check.status]}] ${check.label}\n    ${check.detail}`)
    .join('\n')

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默：面板上的文字本来就能手动选中复制
    }
  }

  return (
    <div className="diagnostics" role="dialog" aria-label="诊断面板">
      <div className="diagnostics-head">
        <span className="diagnostics-title">一键诊断</span>
        <span className="diagnostics-hint">再按 Ctrl+Shift+D 关闭</span>
        <button className="diagnostics-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      <div className="diagnostics-body">
        {checks.map((check, index) => (
          <div key={index} className={`diagnostics-row ${check.status}`}>
            <span className="diagnostics-mark">{STATUS_MARK[check.status]}</span>
            <span className="diagnostics-label">{check.label}</span>
            <span className="diagnostics-detail">{check.detail}</span>
          </div>
        ))}
        {probing && (
          <div className="diagnostics-row warn">
            <span className="diagnostics-mark">…</span>
            <span className="diagnostics-detail">正在探测图片 Content-Type…</span>
          </div>
        )}
      </div>

      <div className="diagnostics-foot">
        <button onClick={() => void copyReport()} disabled={checks.length === 0}>
          {copied ? '已复制 ✓' : '复制诊断报告'}
        </button>
        <span className="diagnostics-hint">把报告粘贴给开发者，即可定位问题</span>
      </div>
    </div>
  )
}
