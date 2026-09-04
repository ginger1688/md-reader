import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/*
 * React 19 的 dangerouslySetInnerHTML 回归测试。
 *
 * 这个坑排查了整整五轮才定位到，而且从代码上**完全看不出来**——
 * `{{ __html: doc.html }}` 长得人畜无害，却在每次重渲染时把整篇正文
 * 销毁重建一遍，顺手冲掉标题 id、复制按钮和查找的文本节点引用。
 *
 * 之所以必须写成自动化测试：它不会报错、不打日志、桌面开发环境也基本看不出来，
 * 只有装机实跑才会暴露（本项目就是这么踩到的）。写在这里，以后谁改回内联字面量
 * 立刻红灯。
 *
 * 断言的是 React 的行为本身，不是我们自己的代码：
 *   内联字面量 → 每次重渲染都重写 innerHTML（坏的）
 *   useMemo 钉住引用 → 内容没变就一次都不写（好的）
 *
 * 跑：npm test（已串进主测试脚本）
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
})
const w = dom.window as unknown as Record<string, unknown>
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
// 不要设 g.navigator：Node 24 已有内置的 navigator 且是只读 getter，直接赋值会抛错。
// React 用的是 window.navigator，jsdom 自己带，不受影响。
g.requestAnimationFrame = dom.window.requestAnimationFrame
g.cancelAnimationFrame = dom.window.cancelAnimationFrame
g.Element = w.Element
g.HTMLElement = w.HTMLElement
g.Node = w.Node
g.Text = w.Text
g.DocumentFragment = w.DocumentFragment
g.HTMLTemplateElement = w.HTMLTemplateElement
// React 19 的 act() 要求显式声明「当前处于测试环境」
g.IS_REACT_ACT_ENVIRONMENT = true

const reactModule = await import('react')
const React = (reactModule as unknown as { default: typeof reactModule }).default ??
  reactModule
const { act, useMemo, createElement } = React
const clientModule = await import('react-dom/client')
const { createRoot } =
  (clientModule as unknown as { default: typeof clientModule }).default ?? clientModule

const HTML = '<h1>标题</h1><p>正文一段</p><pre><code>const a = 1</code></pre>'

/*
 * 两种写法，内容完全相同，唯一区别是 dangerouslySetInnerHTML 的
 * 对象引用在多次渲染之间稳不稳定。
 * 用 data-tick 制造一次无关的属性变化，强制 React 重渲染这个节点。
 */
function InlineLiteral({ html, tick }: { html: string; tick: number }) {
  return createElement('article', {
    className: 'markdown-body',
    'data-tick': String(tick),
    dangerouslySetInnerHTML: { __html: html },
  })
}

function Memoized({ html, tick }: { html: string; tick: number }) {
  const value = useMemo(() => ({ __html: html }), [html])
  return createElement('article', {
    className: 'markdown-body',
    'data-tick': String(tick),
    dangerouslySetInnerHTML: value,
  })
}

/**
 * 渲染一次 → 装 innerHTML 计数器 → 用**相同内容**再渲染两次 → 返回重写次数。
 * 首次渲染那一次写入是 React 自己填内容，不算，所以从装完计数器之后才开始数。
 */
function countRewrites(
  Component: (props: { html: string; tick: number }) => unknown,
): number {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  // @ts-expect-error act 的回调签名在 React 19 里是 (() => void) | (() => Promise<void>)
  act(() => {
    root.render(createElement(Component as never, { html: HTML, tick: 0 }))
  })

  const article = container.querySelector('article')
  assert.ok(article, '首次渲染后应该能找到 article')

  let writes = 0
  const native = Object.getOwnPropertyDescriptor(
    dom.window.Element.prototype,
    'innerHTML',
  )
  assert.ok(native?.set, 'Element.prototype.innerHTML 应该有 setter')

  Object.defineProperty(article, 'innerHTML', {
    configurable: true,
    get() {
      return native.get?.call(this) ?? ''
    },
    set(value: string) {
      writes += 1
      native.set?.call(this, value)
    },
  })

  for (const tick of [1, 2, 3]) {
    // @ts-expect-error 同上
    act(() => {
      root.render(createElement(Component as never, { html: HTML, tick }))
    })
  }

  // @ts-expect-error 同上
  act(() => {
    root.unmount()
  })
  container.remove()
  return writes
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\nReact 19 的 dangerouslySetInnerHTML 引用稳定性：')

test('内联对象字面量：每次重渲染都会重写 innerHTML（这就是那个 bug）', () => {
  assert.equal(
    countRewrites(InlineLiteral),
    3,
    '三次重渲染应当各重写一次；若这里是 0，说明 React 改了比较方式，本测试的前提需要复核',
  )
})

test('useMemo 钉住引用后：内容不变则一次都不重写（修法）', () => {
  assert.equal(countRewrites(Memoized), 0)
})

console.log(`\n${passed} 通过，${failed} 失败\n`)
if (failed > 0) process.exit(1)
