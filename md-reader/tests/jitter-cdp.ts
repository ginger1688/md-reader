/*
 * GBK 抖动实测：CDP 接 Chrome，启 8 秒内的 layout shift 与各元素的 mutation 计数。
 *
 * 为什么独立成脚本：perf-cdp.ts 是滚动/灯箱/外链三类指标，抖动是文档打开期的现象，
 * 单独一份脚本更聚焦。
 *
 * 为什么用 Chrome 而不是 Tauri 的 WebView2：WebView2 屏蔽 --remote-debugging-port，
 * 接不上 CDP；Chrome 与 WebView2 同源 Chromium，React 重渲染 → inline style mutation
 * → reflow → layout shift 这条链路完全一致。视觉抖动 = layout shift 的视觉表现，
 * 跨实现一致，Chrome 测得 0 即在 WebView2 上也是 0。
 *
 * 前置：另开一个终端跑 `npm run dev`（Vite 在 1420）。
 * 运行：npm run jitter
 *
 * 窗口必须可见、别遮挡 —— 不可见窗口的 rAF 会被 Chromium 降频，量到的是节流而不是成本。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = 'http://localhost:1420'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 9322)

const SAMPLES = join('E:', 'workbuddy', 'MD阅读器', '测试样例')
const GBK = join(SAMPLES, 'GBK 编码样例.md')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const MEASURE_MS = 8000
const ITERATIONS = Number(process.env.ITERATIONS ?? 3)
const ITERATION_DELAY_MS = 1000

type JitterMetrics = {
  progressBarMutations: number
  backToTopMutations: number
  scrollEvents: number
  layoutShiftScore: number
  layoutShiftCount: number
  longTaskCount: number
  longTaskMaxMs: number
}

// --- 桩后端 ---------------------------------------------------------------

function startBackend(startupPath: string): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    // CORS 预检：stub 后端走 fetch + JSON，浏览器会先发 OPTIONS。
    // 不处理这个 404 后会让 fetch 直接报 "TypeError: Failed to fetch"，
    // 整个 stub 后端就废了 —— 之前 jitter 跑不通的根因。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/invoke') {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        req.on('data', (chunk) => (data += chunk))
        req.on('end', () => resolve(data))
      })
      const { cmd, args } = JSON.parse(body) as { cmd: string; args: Record<string, string> }
      // 先把结果算出来：try-catch 拦的是 runCommand 的逻辑错，不是 HTTP 写的错。
      // 一份响应只能 writeHead 一次，所以要把成功 / 失败两条路径收成一条 writeHead。
      let payload: { result?: unknown; error?: string }
      try {
        payload = { result: await runCommand(cmd, args, startupPath) }
      } catch (e) {
        payload = { error: String(e instanceof Error ? e.message : e) }
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify(payload))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return server
}

/*
 * GBK 解码 rust 端就干完了，前端拿到的是已经解好的字符串。
 * 桩后端为最小负担，直接读字节按 utf-8 / gbk 喂给前端 —— DOM 结构与真 GBK 一致。
 * 抖动若在「React 重渲 / DOM 写」而不是「解码」上，就能复现。
 */
async function runCommand(
  cmd: string,
  args: Record<string, string>,
  startupPath: string,
): Promise<unknown> {
  if (cmd === 'take_startup_file') return startupPath
  if (cmd === 'read_markdown_file') {
    // 测抖动只关心 DOM 结构够不够触发 React 重渲，编码细节无关。
    // 用 utf-8 非 fatal 解码：GBK 字节会拿到 mojibake + 替换字符，但
    // markdown 解析出来的 pre / table / task-list 节点形状与真 GBK 一致。
    // 真 GBK 走法会让前端弹「按 GBK 打开」按钮，按钮要用户点才能完成
    // 文档加载 —— 这条路径对抖动成本更高，但本次测的是 UI ready 之后的 8 秒。
    const bytes = await readFile(args.path)
    return new TextDecoder('utf-8').decode(bytes)
  }
  if (cmd === 'read_file_as') {
    const bytes = await readFile(args.path)
    return new TextDecoder('gbk').decode(bytes)
  }
  throw new Error(`桩后端没实现命令：${cmd}`)
}

// --- CDP ------------------------------------------------------------------

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void }

class Cdp {
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
      if (message.id === undefined) return
      const slot = this.pending.get(message.id)
      if (!slot) return
      this.pending.delete(message.id)
      if (message.error) slot.reject(new Error(message.error.message))
      else slot.resolve(message.result)
    })
  }

  send<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      result: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression: `(() => { return ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails
      throw new Error(detail.exception?.description ?? detail.text ?? '页面里抛了异常')
    }
    return response.result.value as T
  }

  close(): void {
    this.ws.close()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- 抖动测量脚本 ---------------------------------------------------------

// --- 主流程 ----------------------------------------------------------------

/*
 * 在页面上挂两个观察者：
 *   1. MutationObserver → 监听 .progress-bar / .back-to-top 这两个节点的 attribute 改动。
 *      修复后这两项应为 0：进度条走 ref + 直写 transform（不进 React），back-to-top 始终挂载。
 *   2. PerformanceObserver(layout-shift / longtask) → 测量窗口内的累计 layout shift
 *      与 long task。即使 mutation 为 0，仍可能有 layout shift（比如字体fallback / SVG 重排），
 *      这一项可以发现「React 层安静了但 DOM/渲染层仍抖」的回归。
 * 同时监听 scroll：打开文档不会有滚动，>0 就是误报。
 */
const JITTER_ATTACH_OBSERVERS = `(async () => {
  window.__jitter_progress_mutations = 0
  window.__jitter_btt_mutations = 0
  window.__jitter_scroll_count = 0
  window.__jitter_shift_score = 0
  window.__jitter_shift_count = 0
  window.__jitter_long_count = 0
  window.__jitter_long_max = 0

  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target === window.__progress_bar_ref) window.__jitter_progress_mutations++
      if (r.target === window.__back_to_top_ref) window.__jitter_btt_mutations++
    }
  })
  const bar = document.querySelector('.progress-bar')
  const btt = document.querySelector('.back-to-top')
  if (bar) {
    window.__progress_bar_ref = bar
    obs.observe(bar, { attributes: true, attributeFilter: ['style', 'class'] })
  }
  if (btt) {
    window.__back_to_top_ref = btt
    obs.observe(btt, { attributes: true, attributeFilter: ['class', 'style'] })
  }
  const scrollHandler = () => { window.__jitter_scroll_count++ }
  window.addEventListener('scroll', scrollHandler, { passive: true, capture: true })
  window.__jitter_observer = obs
  window.__jitter_scroll_handler = scrollHandler

  let perf
  try {
    perf = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'layout-shift' && entry.hadRecentInput !== true) {
          window.__jitter_shift_score += entry.value
          window.__jitter_shift_count++
        } else if (entry.entryType === 'longtask') {
          window.__jitter_long_count++
          if (entry.duration > window.__jitter_long_max) window.__jitter_long_max = entry.duration
        }
      }
    })
    perf.observe({ type: 'layout-shift', buffered: true })
    perf.observe({ type: 'longtask', buffered: true })
  } catch {
    // 老 Chromium 上 layout-shift / longtask 不可观察，记 0 即可
  }
  window.__jitter_perf = perf
  return { hasProgressBar: !!bar, hasBackToTop: !!btt }
})()`

/*
 * 拿到本次测量的全部指标。observer 必须 disconnect 才不会泄漏到下一次迭代。
 */
const JITTER_TEARDOWN = `(async () => {
  try { window.__jitter_observer?.disconnect() } catch {}
  try { window.removeEventListener('scroll', window.__jitter_scroll_handler, { capture: true }) } catch {}
  try { window.__jitter_perf?.disconnect() } catch {}
  return {
    progressBarMutations: window.__jitter_progress_mutations ?? 0,
    backToTopMutations: window.__jitter_btt_mutations ?? 0,
    scrollEvents: window.__jitter_scroll_count ?? 0,
    layoutShiftScore: window.__jitter_shift_score ?? 0,
    layoutShiftCount: window.__jitter_shift_count ?? 0,
    longTaskCount: window.__jitter_long_count ?? 0,
    longTaskMaxMs: window.__jitter_long_max ?? 0,
  }
})()`

async function runOnce(): Promise<JitterMetrics> {
  const backend = startBackend(GBK)
  await new Promise<void>((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve))

  const profile = mkdtempSync(join(tmpdir(), 'md-jitter-'))
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--remote-allow-origins=*`,
      `--user-data-dir=${profile}`,
      `--window-size=1280,900`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  chrome.stderr?.on('data', (b) => process.stderr.write(`[chrome] ${b}`))

  try {
    const target = await waitForTarget()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
    await cdp.send('Page.navigate', { url: `${APP_URL}/?startup=${encodeURIComponent(GBK)}` })
    await waitForArticle(cdp)

    // Article 渲染完后再 attach observer —— 此时拿到的 progress-bar / back-to-top
    // 是 setDoc 之后的真实 DOM。observer 监听后续 8 秒窗口内的全部 attribute mutation
    // + layout-shift + longtask，捕捉修复后应为 0 的抖动信号。
    await cdp.evaluate(JITTER_ATTACH_OBSERVERS as unknown as string)
    await sleep(MEASURE_MS)

    const metrics = await cdp.evaluate<JitterMetrics>(JITTER_TEARDOWN as unknown as string)
    cdp.close()
    return metrics
  } finally {
    chrome.kill()
    backend.close()
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length === 0
    ? 0
    : sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2
}

function aggregate(runs: JitterMetrics[]): JitterMetrics {
  return {
    progressBarMutations: median(runs.map((r) => r.progressBarMutations)),
    backToTopMutations: median(runs.map((r) => r.backToTopMutations)),
    scrollEvents: median(runs.map((r) => r.scrollEvents)),
    layoutShiftScore: median(runs.map((r) => r.layoutShiftScore)),
    layoutShiftCount: median(runs.map((r) => r.layoutShiftCount)),
    longTaskCount: median(runs.map((r) => r.longTaskCount)),
    longTaskMaxMs: median(runs.map((r) => r.longTaskMaxMs)),
  }
}

function printTable(runs: JitterMetrics[]): void {
  const med = aggregate(runs)
  const header = ['指标', ...runs.map((_, i) => `#${i + 1}`), '中位']

  const rows: { label: string; key: keyof JitterMetrics; unit: string; format: (n: number) => string }[] = [
    {
      label: 'ProgressBar 改写',
      key: 'progressBarMutations',
      unit: '次',
      format: (n) => String(n),
    },
    {
      label: 'BackToTop 改写',
      key: 'backToTopMutations',
      unit: '次',
      format: (n) => String(n),
    },
    {
      label: 'Scroll 事件',
      key: 'scrollEvents',
      unit: '次',
      format: (n) => String(n),
    },
    {
      label: 'Layout Shift 累计值',
      key: 'layoutShiftScore',
      unit: '分',
      format: (n) => n.toFixed(3),
    },
    {
      label: 'Layout Shift 次数',
      key: 'layoutShiftCount',
      unit: '次',
      format: (n) => String(n),
    },
    {
      label: 'LongTask 数',
      key: 'longTaskCount',
      unit: '次',
      format: (n) => String(n),
    },
    {
      label: 'LongTask 最长',
      key: 'longTaskMaxMs',
      unit: 'ms',
      format: (n) => n.toFixed(0),
    },
  ]

  // 计算列宽：取每行最长的内容
  const colWidths = header.map((h, i) => {
    const headerW = h.length
    const valMax = rows.reduce((m, r) => {
      const sample = i === 0 ? '' : i > runs.length ? r.format((aggregate(runs) as JitterMetrics)[r.key]) : r.format(runs[i - 1][r.key])
      return Math.max(m, sample.length)
    }, 0)
    return Math.max(headerW, valMax)
  })
  const labelW = Math.max(...rows.map((r) => r.label.length))

  const fmtRow = (cells: (string | number)[], label: string) => {
    const padded = cells.map((c, i) => String(c).padStart(colWidths[i], ' '))
    return `  ${label.padEnd(labelW, ' ')}  ${padded.join('  ')}`
  }
  const sepRow = () => {
    const totalW = labelW + 2 + colWidths.reduce((a, b) => a + b + 2, 0)
    return '  ' + '─'.repeat(totalW - 2)
  }

  console.log(`\n=== GBK 抖动测量（中位 of ${runs.length}，窗口 ${MEASURE_MS / 1000}s）===`)
  console.log(fmtRow(header, ''))
  console.log(sepRow())
  for (const r of rows) {
    const cells: string[] = [
      ...runs.map((run) => r.format(run[r.key])),
      r.format(med[r.key]),
    ]
    console.log(fmtRow(cells, r.label) + `  ${r.unit}`)
  }

  // 判读：根据中位数给一个综合结论
  const verdict = []
  if (med.progressBarMutations === 0) verdict.push('进度条：ref 直写生效')
  else verdict.push(`进度条：仍有 ${med.progressBarMutations} 次改写（应≈0）`)
  if (med.backToTopMutations <= 1) verdict.push('back-to-top：始终挂载正确')
  else verdict.push(`back-to-top：${med.backToTopMutations} 次切换`)
  if (med.scrollEvents === 0) verdict.push('scroll：打开期零滚动（干净）')
  else verdict.push(`scroll：${med.scrollEvents} 次意外触发`)
  if (med.layoutShiftScore < 0.05) verdict.push('layout shift：累计 < 0.05（无可见抖动）')
  else verdict.push(`layout shift：累计 ${med.layoutShiftScore.toFixed(3)}（肉眼可见）`)

  console.log('')
  console.log('  判读（基于中位数）：')
  for (const v of verdict) console.log(`    - ${v}`)
}

async function main() {
  if (ITERATIONS < 1 || !Number.isInteger(ITERATIONS)) {
    throw new Error(`ITERATIONS 必须是正整数，当前 ${ITERATIONS}`)
  }
  console.log(`准备跑 ${ITERATIONS} 次 取中位（每轮 ${MEASURE_MS / 1000}s + 重启 Chrome 约 2s）...`)
  const runs: JitterMetrics[] = []
  for (let i = 1; i <= ITERATIONS; i++) {
    console.log(`\n── 第 ${i}/${ITERATIONS} 次 ──`)
    const m = await runOnce()
    runs.push(m)
    console.log(
      `   ProgressBar=${m.progressBarMutations}  BackToTop=${m.backToTopMutations}` +
        `  Scroll=${m.scrollEvents}  Shift=${m.layoutShiftScore.toFixed(3)} (${m.layoutShiftCount})` +
        `  LongTask=${m.longTaskCount} max=${m.longTaskMaxMs.toFixed(0)}ms`,
    )
    if (i < ITERATIONS) await sleep(ITERATION_DELAY_MS)
  }
  printTable(runs)
}

const STUB = `(() => {
  const BACKEND = 'http://127.0.0.1:${BACKEND_PORT}'
  const startup = ${JSON.stringify(GBK)}
  let nextId = 0
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    transformCallback: (fn, once) => {
      const key = '_tauri_cb_' + ++nextId
      window[key] = (...args) => { if (once) delete window[key]; return fn(...args) }
      return nextId
    },
    invoke: async (cmd, args) => {
      if (cmd.startsWith('plugin:window|')) return null
      if (cmd === 'take_startup_file') return startup
      const res = await fetch(BACKEND + '/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd, args }),
      })
      const body = await res.json()
      if (body.error) throw new Error(body.error)
      return body.result
    },
  }
})()`

async function waitForTarget(): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const targets = (await response.json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
      }>
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      // 等
    }
    await sleep(500)
  }
  throw new Error(`等不到 ${CDP_PORT} 上的 page 目标`)
}

async function waitForArticle(cdp: Cdp): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await cdp.evaluate<{
      ready: boolean
      size: number
      hasArticle: boolean
      hasTitle: string
      hasMarkdownHtml: string
      tauriStub: boolean
    }>(
      `(() => {
        const a = document.querySelector('article.markdown-body')
        const title = document.title || ''
        return {
          ready: !!a && (a.textContent || '').length > 50,
          size: a ? a.textContent.length : 0,
          hasArticle: !!a,
          hasTitle: title.slice(0, 80),
          hasMarkdownHtml: ((document.querySelector('.markdown-body') || {}).innerHTML || '').slice(0, 200),
          tauriStub: '__TAURI_INTERNALS__' in window,
        }
      })()`,
    )
    if (state.ready) {
      console.log(`  文档已渲染：正文 ${state.size} 字符，title="${state.hasTitle}"`)
      return
    }
    if (attempt === 0 || attempt % 5 === 0) {
      console.log(
        `  [探 ${attempt}] article=${state.hasArticle} tauriStub=${state.tauriStub} title="${state.hasTitle}"`,
      )
    }
    await sleep(1000)
  }
  const dump = await cdp.evaluate<{
    body: string
    ta: number
    ex: number
  }>(
    `(() => ({
      body: (document.body.innerText || '').slice(0, 500),
      ta: document.querySelectorAll('textarea').length,
      ex: document.querySelectorAll('.error').length,
    }))()`,
  )
  throw new Error(
    `60 秒内没等到文档渲染\n  body="${dump.body}"\n  textareas=${dump.ta}\n  error blocks=${dump.ex}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
