/*
 * 在真实浏览器窗口里测量 v0.2 剩下的两条性能出口条件，顺带自动验一次外链拦截。
 *
 * 为什么不用 Tauri 窗口：WebView2 屏蔽 --remote-debugging-port，
 * 拿不到 CDP 就编不出滚动与图片加载的程序化测量。
 * 这里退一步，用 Chrome 跑同一个前端 —— 渲染引擎、布局、绘制、
 * 图片解码路径与 WebView2 一致，量到的数字对「排版与解码成本」是有代表性的。
 * 差出去的是 Tauri 自身的进程模型与 asset 协议，对这两条指标影响很小。
 *
 * 为了让前端在浏览器里跑起来，脚本做了两件事：
 *   1. 起一个本地桩后端，顶替三条 Rust 命令和 asset 协议；
 *   2. 用 Page.addScriptToEvaluateOnNewDocument 注入 __TAURI_INTERNALS__。
 * 前端代码一行都不用改 —— 它本来就靠 inTauri 分流。
 *
 * 前置：另开一个终端跑 `npm run dev`（Vite 在 1420）。
 * 然后：npm run perf
 *
 * 注意：会弹出一个真实的 Chrome 窗口，测完自动关。
 * 窗口必须可见且不被遮挡，否则 Chromium 会对 rAF 降频，量到的是调度节流。
 */

import { createServer } from 'node:http'
import { createReadStream, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const APP_URL = 'http://localhost:1420'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222)
/// 桩后端端口。Chrome 用 --host-resolver-rules 把 asset.localhost 指到这里。
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 9321)

const SAMPLES = join('E:', 'workbuddy', 'MD阅读器', '测试样例')
const BIG_DOC = join(SAMPLES, '大文档-5MB.md')
const LIGHTBOX_DOC = join(SAMPLES, '灯箱-10MB图.md')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const SCROLL_FRAMES = 400
const SCROLL_STEP = 60 // 每次 rAF 滚这么多像素，约等于按住方向键的速度
const WINDOW_SIZE = '1280,900'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
}

// --- 桩后端 ---------------------------------------------------------------

function startBackend(startupPath: string): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname === '/invoke') {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        req.on('data', (chunk) => (data += chunk))
        req.on('end', () => resolve(data))
      })
      const { cmd, args } = JSON.parse(body) as { cmd: string; args: Record<string, string> }
      try {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: await runCommand(cmd, args, startupPath) }))
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
      }
      return
    }

    // asset 协议：convertFileSrc 生成的是 http://asset.localhost/<编码后的路径>
    const encoded =
      url.pathname === '/file' ? (url.searchParams.get('path') ?? '') : url.pathname.slice(1)
    const path = decodeURIComponent(encoded)
    if (!statSyncSafe(path)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(path).size,
      'access-control-allow-origin': '*',
    })
    createReadStream(path).pipe(res)
  })

  return server
}

function statSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/*
 * 只实现了测量用得到的东西。
 * read_file_as（GBK）用不到，走到就直接报错 —— 免得悄悄给出一份假数据。
 */
async function runCommand(
  cmd: string,
  args: Record<string, string>,
  startupPath: string,
): Promise<unknown> {
  if (cmd === 'take_startup_file') return startupPath
  if (cmd === 'read_markdown_file') {
    const bytes = await readFile(args.path)
    // 与 Rust 侧对齐：解不开就报 ERR_NOT_UTF8，前端据此给出「按 GBK 打开」
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('ERR_NOT_UTF8')
    }
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

  /// 在页面里跑一段脚本。表达式必须是 IIFE，返回值要能被结构化克隆。
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      result: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression: `(() => { return ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    // 不把异常摊开来的话，页面里报错只会得到一个 undefined，排查全靠猜
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

function percentiles(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

// --- 页面里的测量脚本 ------------------------------------------------------

/*
 * 滚动帧率：在 rAF 回调里每帧推进一次 scrollTop，同时记录帧间隔。
 * 这样每一帧都包含「滚动 + 布局 + 绘制」的完整成本，
 * 而不是空闲时的 rAF 间隔（空闲时永远是 16.7 ms，量了也白量）。
 */
const MEASURE_SCROLL = `(async () => {
  const el = document.querySelector('.content')
  if (!el) return { error: '找不到 .content 滚动容器' }
  if (el.scrollHeight <= el.clientHeight) return { error: '内容没有溢出，滚不起来' }

  el.scrollTop = 0
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  const deltas = []
  const start = el.scrollTop
  await new Promise((resolve) => {
    let last = performance.now()
    let n = 0
    function tick(now) {
      deltas.push(now - last)
      last = now
      el.scrollTop += ${SCROLL_STEP}
      n++
      if (n >= ${SCROLL_FRAMES} || el.scrollTop >= el.scrollHeight - el.clientHeight) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  deltas.splice(0, 2) // 前两帧含起步与首次布局的一次性开销
  return { frames: deltas.length, pixels: el.scrollTop - start, deltas }
})()`

/*
 * 10 MB 图的首载耗时：从换文档到图解码完成并真正上屏。
 *
 * 这才是「10 MB 图」这条出口条件里真正有成本的部分 —— 读盘加解码。
 * 灯箱本身只是把已经解码好的图换个容器显示，命中缓存后基本没有成本，
 * 所以下面那个灯箱耗时只能当参考，不能当结论。
 */
const WATCH_IMAGE = `(async () => {
  const t0 = performance.now()
  const deadline = t0 + 60000
  while (performance.now() < deadline) {
    const img = document.querySelector('article img')
    // src 里带 '10MB' 才算数：换文档时旧文档的图还在 DOM 上待一小会儿
    if (img && img.complete && img.naturalWidth > 0 && img.src.includes('10MB')) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return { ms: performance.now() - t0, width: img.naturalWidth, height: img.naturalHeight }
    }
    await new Promise((r) => setTimeout(r, 4))
  }
  return { error: '60 s 内没等到 10 MB 图加载完成' }
})()`

const MEASURE_LIGHTBOX = `(async () => {
  const img = document.querySelector('article img')
  if (!img) return { error: '文章里没有图片' }
  const t0 = performance.now()
  img.click()
  const deadline = t0 + 30000
  while (performance.now() < deadline) {
    const shown = document.querySelector('.lightbox img.lightbox-image')
    if (shown && shown.complete && shown.naturalWidth > 0) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return { ms: performance.now() - t0 }
    }
    await new Promise((r) => setTimeout(r, 4))
  }
  return { error: '30 s 内没等到灯箱出现' }
})()`

const CLOSE_LIGHTBOX = `(() => {
  const btn = document.querySelector('.lightbox-actions button')
  if (btn) btn.click()
  return true
})()`

/*
 * 外链拦截。点一个 https 链接，拦住了 location 就不变；
 * 没拦住的话整个窗口会导航走，这里连结果都收不回来。
 */
const CHECK_LINK = `(() => {
  const a = document.querySelector('article a[href^="https://"]')
  if (!a) return { error: '文章里没有 https 外链' }
  const before = location.href
  a.click()
  return { href: a.getAttribute('href'), before, after: location.href }
})()`

// --- 主流程 ----------------------------------------------------------------

async function main() {
  const backend = startBackend(BIG_DOC)
  await new Promise<void>((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve))

  const profile = mkdtempSync(join(tmpdir(), 'md-perf-'))
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--remote-allow-origins=*`,
      // convertFileSrc 产出 http://asset.localhost/...，把它指到桩后端
      `--host-resolver-rules=MAP asset.localhost 127.0.0.1:${BACKEND_PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WINDOW_SIZE}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

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
    await cdp.send('DOM.enable')

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
    await cdp.send('Page.navigate', { url: `${APP_URL}/?startup=${encodeURIComponent(BIG_DOC)}` })
    await waitForApp(cdp)

    console.log('\n=== 1. 5 MB 文档滚动帧率 ===')
    await reportScroll(cdp)

    console.log('\n=== 2. 10 MB 图：首载 与 灯箱 ===')
    await reportImage(cdp)

    console.log('\n=== 3. 外链拦截 ===')
    await reportLink(cdp)

    cdp.close()
  } finally {
    chrome.kill()
    backend.close()
  }
}

const STUB = `(() => {
  const BACKEND = 'http://127.0.0.1:${BACKEND_PORT}'
  const startup = new URLSearchParams(location.search).get('startup')
  let nextId = 0
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    transformCallback: (fn, once) => {
      const key = '_tauri_cb_' + ++nextId
      window[key] = (...args) => { if (once) delete window[key]; return fn(...args) }
      return nextId
    },
    invoke: async (cmd, args) => {
      // 窗口类命令（setTitle 等）不影响渲染结果，直接放行
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
      // 浏览器还没起来
    }
    await sleep(500)
  }
  throw new Error(`等不到 ${CDP_PORT} 上的 page 目标`)
}

/// 等文档渲染完。5 MB 文档里有一千多个代码块，高亮是异步的，得等它停稳。
async function waitForApp(cdp: Cdp): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt++) {
    const state = await cdp.evaluate<{ ready: boolean; images: number; height: number }>(
      `(() => {
        const el = document.querySelector('.content')
        const article = document.querySelector('article')
        return {
          ready: !!el && !!article && article.textContent.length > 100000,
          images: document.querySelectorAll('article img').length,
          height: el ? el.scrollHeight : 0,
        }
      })()`,
    )
    if (state.ready) {
      console.log(
        `文档已渲染：正文 ${state.height} px 高，${state.images} 张图，再等 3 s 让高亮跑完`,
      )
      await sleep(3000)
      return
    }
    await sleep(1000)
  }
  const dump = await cdp.evaluate<{ title: string; text: string; tauri: boolean }>(
    `(() => ({
      title: document.title,
      text: (document.body.innerText || '').slice(0, 600),
      tauri: '__TAURI_INTERNALS__' in window,
    }))()`,
  )
  throw new Error(
    `3 分钟内没等到文档渲染完成\n` +
      `  title: ${dump.title}\n  __TAURI_INTERNALS__: ${dump.tauri}\n  页面文本: ${dump.text}`,
  )
}

type ScrollReport = { error?: string; frames?: number; pixels?: number; deltas?: number[] }

async function reportScroll(cdp: Cdp): Promise<void> {
  const raw = await cdp.evaluate<ScrollReport>(MEASURE_SCROLL)
  if (raw.error || !raw.deltas) {
    console.log(`  ${raw.error}`)
    return
  }
  const stats = percentiles(raw.deltas)
  const over16 = raw.deltas.filter((d) => d > 16.7).length
  const over33 = raw.deltas.filter((d) => d > 33.4).length
  console.log(`  采样帧数     ${raw.frames}`)
  console.log(`  滚动距离     ${raw.pixels} px`)
  console.log(`  帧间隔 p50   ${stats.p50.toFixed(2)} ms`)
  console.log(`  帧间隔 p95   ${stats.p95.toFixed(2)} ms`)
  console.log(`  帧间隔 max   ${stats.max.toFixed(2)} ms`)
  console.log(`  > 16.7 ms    ${over16} 帧（${((over16 / raw.frames!) * 100).toFixed(1)}%）`)
  console.log(`  > 33.4 ms    ${over33} 帧（${((over33 / raw.frames!) * 100).toFixed(1)}%）`)
  console.log(
    `  折算 fps     p50 ${(1000 / stats.p50).toFixed(1)} / p95 ${(1000 / stats.p95).toFixed(1)}`,
  )
}

type ImageReport = { error?: string; ms?: number; width?: number; height?: number }

async function reportImage(cdp: Cdp): Promise<void> {
  const root = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
  const input = await cdp.send<{ nodeId: number }>('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector: 'input[type=file]',
  })
  if (!input.nodeId) {
    console.log('  找不到隐藏的文件选择框，跳过')
    return
  }

  // 先让页面里的等待跑起来，再塞文件，否则会错过起点
  const watching = cdp.evaluate<ImageReport>(WATCH_IMAGE)
  await cdp.send('DOM.setFileInputFiles', { files: [LIGHTBOX_DOC], nodeId: input.nodeId })
  const first = await watching
  if (first.error) console.log(`  首载         ${first.error}`)
  else
    console.log(
      `  首载         ${first.ms!.toFixed(0)} ms（${first.width} × ${first.height}，含读盘与解码）`,
    )

  const box = await cdp.evaluate<ImageReport>(MEASURE_LIGHTBOX)
  if (box.error) console.log(`  灯箱         ${box.error}`)
  else console.log(`  灯箱         ${box.ms!.toFixed(0)} ms（命中缓存，仅供参考）`)
  await cdp.evaluate(CLOSE_LIGHTBOX)
}

async function reportLink(cdp: Cdp): Promise<void> {
  const link = await cdp.evaluate<{ error?: string; href: string; before: string; after: string }>(
    CHECK_LINK,
  )
  if (link.error) {
    console.log(`  ${link.error}`)
    return
  }
  const held = link.before === link.after
  console.log(`  点击链接     ${link.href}`)
  console.log(`  location     ${held ? '未改变 ✅ 已被拦下' : `被导航到 ${link.after} ❌`}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
