import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/*
 * 核心算法验证。
 *
 * 这里只测「算错了不容易被肉眼发现」的部分：
 * 跨行内元素的查找匹配、同名标题的 id 去重、HTML 白名单的清洗结果。
 * 渲染样式、交互手感这类东西留给人工验收，写自动化测试不划算。
 *
 * 清洗规则尤其需要自动化：onclick 被没被剥掉、href 里的 javascript: 有没有被
 * 拦下来，光看页面是看不出来的。
 *
 * 跑：npm test
 */

// findRanges 用到 document.createRange，DOMPurify 还要 window 与一批 DOM 构造器，
// 得先把全局装好再动态导入模块。
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

const { findOffsets, rangeAt, visibleIndices } = await import('../src/find/index')
const { collectHeadings } = await import('../src/markdown/headings')
const { sanitizeHtml } = await import('../src/markdown/sanitize')
const { renderMarkdown } = await import('../src/markdown/render')
import type { FindOptions } from '../src/find'

/*
 * 新接口只返回偏移，Range 要按需建（建 Range 极贵，见 find/index.ts 的说明）。
 * 查找这一组用例断言的是「哪些位置该被匹配到」，跟是不是 Range 无关，
 * 所以在这里统一转一次，已有的断言一个都不用改。
 */
function findRanges(root: HTMLElement, query: string, options: FindOptions): Range[] {
  const result = findOffsets(root, query, options)
  return result.offsets
    .map((_, index) => rangeAt(result, index))
    .filter((range): range is Range => range !== null)
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

function container(html: string): HTMLElement {
  // 每个用例前清空。不清的话上一个 case 挂在 body 上的 id 会被下一个查到，
  // 而 collectHeadings 现在要避让文档里已存在的 id —— 用例之间会互相污染。
  document.body.innerHTML = ''
  const element = document.createElement('div')
  element.innerHTML = html
  document.body.appendChild(element)
  return element
}

const NO_OPTIONS = { caseSensitive: false, wholeWord: false }

console.log('\n查找：')
test('普通文本能找到', () => {
  const root = container('<p>hello world</p>')
  assert.equal(findRanges(root, 'world', NO_OPTIONS).length, 1)
})

test('一处文本里的多次出现都算上', () => {
  const root = container('<p>cat category cat</p>')
  // 「cat」出现 3 次（category 里含 cat）
  assert.equal(findRanges(root, 'cat', NO_OPTIONS).length, 3)
})

test('跨行内元素的匹配不漏（**加粗** 中间）', () => {
  // 「阅读器」三个字被拆进三个文本节点：阅**读**器
  const root = container('<p>这个<strong>阅读</strong>器很好用</p>')
  const ranges = findRanges(root, '阅读器', NO_OPTIONS)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].toString(), '阅读器')
})

test('跨多个行内元素的长匹配也能拼回来', () => {
  const root = container('<p>MD<em> 阅读</em><strong>器</strong> 发布</p>')
  const ranges = findRanges(root, 'MD 阅读器', NO_OPTIONS)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].toString(), 'MD 阅读器')
})

test('区分大小写开关生效', () => {
  const root = container('<p>Markdown markdown</p>')
  assert.equal(findRanges(root, 'markdown', { caseSensitive: true, wholeWord: false }).length, 1)
  assert.equal(findRanges(root, 'markdown', { caseSensitive: false, wholeWord: false }).length, 2)
})

test('全词匹配不会命中单词的一部分', () => {
  const root = container('<p>cat category concat</p>')
  assert.equal(findRanges(root, 'cat', { caseSensitive: false, wholeWord: true }).length, 1)
})

test('空查询返回空结果', () => {
  const root = container('<p>anything</p>')
  assert.equal(findRanges(root, '', NO_OPTIONS).length, 0)
})

test('查询里的正则元字符被当作普通字符', () => {
  const root = container('<p>a.b acb</p>')
  const ranges = findRanges(root, 'a.b', NO_OPTIONS)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].toString(), 'a.b')
})

test('匹配结果按文档顺序排列', () => {
  const root = container('<p>one</p><p>two</p><p>one</p>')
  const ranges = findRanges(root, 'one', NO_OPTIONS)
  assert.equal(ranges.length, 2)
  assert.ok(ranges[0].compareBoundaryPoints(Range.START_TO_START, ranges[1]) <= 0)
})

/*
 * 增量高亮这组的难点：jsdom 不做排版，它的 Range 连 getBoundingClientRect
 * 都没有（真机 Chromium 上有），所以二分所用的「垂直位置单调」无从谈起，
 * visibleIndices 在这里只能验到 degenerate 情形 —— 不崩、不给出越界下标。
 * 真正的视口裁剪效果要在窗口里人工看。
 */
test('无匹配时可见区间为空，不越界', () => {
  const root = container('<p>nothing here</p>')
  const result = findOffsets(root, '缺失的词', NO_OPTIONS)
  assert.equal(result.offsets.length, 0)
  const { from, to } = visibleIndices(result, root)
  assert.ok(to < from) // 空区间
  assert.equal(rangeAt(result, 0), null)
})

test('rangeAt 对越界下标返回 null 而不是崩', () => {
  const result = findOffsets(container('<p>a b a</p>'), 'a', NO_OPTIONS)
  assert.equal(result.offsets.length, 2)
  assert.equal(rangeAt(result, -1), null)
  assert.equal(rangeAt(result, 2), null)
  assert.ok(rangeAt(result, 1) !== null)
})

test('偏移与长度一一对应，能还原出原文', () => {
  const root = container('<p>第<strong>一</strong>处，第二处</p>')
  const result = findOffsets(root, '处', NO_OPTIONS)
  assert.equal(result.offsets.length, result.lengths.length)
  for (let i = 0; i < result.offsets.length; i++) {
    assert.equal(rangeAt(result, i)?.toString(), '处')
  }
})

console.log('\n大纲：')
test('能提取各级标题并生成 id', () => {
  const root = container('<h1>标题一</h1><h3>标题三</h3>')
  const headings = collectHeadings(root)
  assert.equal(headings.length, 2)
  assert.equal(headings[0].level, 1)
  assert.equal(headings[0].text, '标题一')
  assert.equal(headings[0].id, '标题一')
  assert.equal(headings[1].level, 3)
})

test('id 真的写回了 DOM 元素', () => {
  const root = container('<h2>安装步骤</h2>')
  collectHeadings(root)
  assert.equal(root.querySelector('h2')?.id, '安装步骤')
})

test('同名标题的 id 自动加序号，不撞车', () => {
  const root = container('<h2>说明</h2><h2>说明</h2><h2>说明</h2>')
  const headings = collectHeadings(root)
  assert.deepEqual(
    headings.map((h) => h.id),
    ['说明', '说明-1', '说明-2'],
  )
})

test('纯标点标题兜底成 section，不会生成空 id', () => {
  const root = container('<h2>！！</h2>')
  const headings = collectHeadings(root)
  assert.equal(headings[0].id, 'section')
})

test('标题里的空格与标点被清掉', () => {
  const root = container('<h2>Hello, World! 你好</h2>')
  const headings = collectHeadings(root)
  assert.equal(headings[0].id, 'hello-world-你好')
})

// 白名单放行了 id 属性后，文档里自带的 id 会跟标题抢名字。
// getElementById 取的是先出现的那个，抢输了跳转就跳错地方。
test('标题 id 避开文档里已存在的同名 id', () => {
  const root = container('<div id="说明"></div><h2>说明</h2>')
  const headings = collectHeadings(root)
  assert.equal(headings[0].id, '说明-1')
  assert.equal(root.querySelector('h2')?.id, '说明-1')
})

test('标题已有自己的 id 时保留，不另起炉灶', () => {
  const root = container('<h2 id="custom-id">说明</h2>')
  const headings = collectHeadings(root)
  assert.equal(headings[0].id, 'custom-id')
})

console.log('\nHTML 白名单：')
test('script 与 style 连内容一起消失', () => {
  /*
   * DOMPurify 有个 FORBID_CONTENTS 集合，script / style 这类「内容本就不可见」
   * 的元素被移除时，内容一并丢弃，KEEP_CONTENT 对它们无效。
   * 这比留一段文本更干净 —— 用户不需要看见被拦下的代码长什么样，
   * 而 <style> 的 CSS 若当文本显示出来，反而容易被误当成正文。
   */
  assert.equal(sanitizeHtml("<script>alert('x')</script>"), '')
  assert.equal(sanitizeHtml('<style>body{display:none}</style>'), '')
})

test('不在白名单里的普通标签只剥标签，内容保留', () => {
  assert.ok(sanitizeHtml('<unknown-tag>内容</unknown-tag>').includes('内容'))
})

test('事件属性被无条件剥离，元素本身留下', () => {
  const clean = sanitizeHtml('<div onclick="alert(1)" class="keep">点我</div>')
  assert.ok(!clean.toLowerCase().includes('onclick'))
  assert.ok(clean.includes('点我'))
  assert.ok(clean.includes('class="keep"'))
})

test('style 元素被剥掉，style 属性放行', () => {
  assert.ok(!sanitizeHtml('<style>body{display:none}</style>').includes('<style'))
  assert.ok(sanitizeHtml('<div style="color:red">x</div>').includes('style="color:red"'))
})

test('iframe 与 form 控件被剥掉', () => {
  assert.equal(sanitizeHtml('<iframe src="https://example.com"></iframe>'), '')
  const form = sanitizeHtml('<form action="/x"><input value="v"><button>go</button></form>')
  assert.ok(!form.includes('<form'))
  assert.ok(!form.includes('<input'))
  assert.ok(!form.includes('<button'))
})

test('javascript: 协议的链接被拦下', () => {
  const clean = sanitizeHtml('<a href="javascript:alert(1)">点</a>')
  assert.ok(!clean.includes('javascript:'))
})

test('排版标签放行（details / kbd / sup / mark / abbr）', () => {
  for (const tag of ['details', 'summary', 'kbd', 'sup', 'sub', 'mark', 'abbr', 'ins', 'del']) {
    const clean = sanitizeHtml(`<${tag}>内容</${tag}>`)
    assert.ok(clean.includes(`<${tag}`), `${tag} 应当被放行，实际得到：${clean}`)
  }
})

test('表格的 colspan / rowspan 属性保留', () => {
  const clean = sanitizeHtml('<table><tr><td colspan="2" rowspan="2">x</td></tr></table>')
  assert.ok(clean.includes('colspan="2"'))
  assert.ok(clean.includes('rowspan="2"'))
})

test('内联 SVG 本轮不放行（批次 2 做 Mermaid 时要回来改）', () => {
  const clean = sanitizeHtml('<svg><text>SVG</text></svg>')
  assert.ok(!clean.includes('<svg'))
})

test('id 属性放行（标题锚点冲突由 headings 侧处理）', () => {
  assert.ok(sanitizeHtml('<div id="anchor">x</div>').includes('id="anchor"'))
})

/*
 * 下面一节的动力：把 GFM 官方 spec 的 672 条用例跑过一遍之后，
 * 发现三处「文档写对了、我们渲染错了」的地方。三处都不是样式问题，
 * 是功能直接缺一块，所以每条都留了断言，防止再退回去。
 */
console.log('\n任务列表与自动链接：')
test('任务列表的复选框保留下来', () => {
  const clean = renderMarkdown('- [ ] 待办\n- [x] 已完成')
  assert.ok(clean.includes('<input'), `复选框不该被剥掉：${clean}`)
  assert.ok(clean.includes('type="checkbox"'))
  assert.ok(clean.includes('checked'), '已完成的那一项目该带 checked')
  assert.ok(clean.includes('待办'))
})

test('复选框只留 type / checked / disabled / class', () => {
  const clean = sanitizeHtml('<input type="checkbox" value="v" name="n" onclick="x()">')
  assert.ok(clean.includes('type="checkbox"'))
  assert.ok(!clean.includes('value='))
  assert.ok(!clean.includes('name='))
  assert.ok(!clean.includes('onclick'))
})

test('不是复选框的 input 整个删掉', () => {
  // type=file 能在页面里弹出系统文件对话框，不该由一份文档触发
  assert.equal(sanitizeHtml('<input type="file">'), '')
  assert.equal(sanitizeHtml('<input type="text" value="x">'), '')
  assert.equal(sanitizeHtml('<input>'), '')
})

test('裸域名 www.xxx.com 自动成链', () => {
  const clean = renderMarkdown('见 www.commonmark.org 上的说明')
  assert.ok(clean.includes('href="http://www.commonmark.org"'), `裸域名没成链：${clean}`)
})

test('带协议的裸网址仍然成链', () => {
  const clean = renderMarkdown('见 http://example.com/a?b=1 的说明')
  assert.ok(clean.includes('href="http://example.com/a?b=1"'), `网址没成链：${clean}`)
})

test('不常见的协议不被剥掉 href', () => {
  // 这两条是 CommonMark 规定的自动链接写法，之前洗完只剩个空 <a>
  assert.ok(renderMarkdown('<irc://foo.bar:2233/baz>').includes('href="irc://foo.bar:2233/baz"'))
  assert.ok(renderMarkdown('<localhost:5001/foo>').includes('href="localhost:5001/foo"'))
})

test('危险协议依旧拦住（放宽未知协议的代价不能是这里）', () => {
  for (const uri of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>x</script>']) {
    const clean = sanitizeHtml(`<a href="${uri}">点</a>`)
    assert.ok(!clean.includes('href='), `${uri} 不该留下 href：${clean}`)
  }
})

test('img 的 data: 内联图片不受影响', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo='
  assert.ok(sanitizeHtml(`<img src="${src}">`).includes(src))
})

/*
 * 复制按钮定位回归 —— v0.2.12 把按钮宿主移到 pre 顶部独立区域。
 *
 * 装机实测老版本（v0.2.11）按钮在视觉上"挤进"代码第一行：CSS 是
 * `position: absolute; top: 6px;` 没错，但 pre 的 padding-top 只有 12px，
 * 按钮高 ~22px，于是文字和按钮重叠。在长单行 pre 里就更明显：按钮
 * 看起来像落在行内中间。
 *
 * 修法：把 pre 的 padding-top 抬到能完整容纳按钮 + 一段空隙的尺寸，
 * 并通过 installCopyButtons 的产物校验：每个 pre 后必有一个
 * .md-copy-host，且按钮已加 class、文本按 i18n 设置。
 *
 * 用 jsdom 跑 installCopyButtons 是因为它只依赖 DOM API，没有 React /
 * Tauri 上下文，正好适合做定位不变量的回归。
 */
test('每个 pre / table 都挂上一个独立的复制按钮宿主', () => {
  // installCopyButtons 是按需动态加载的，先 import 拿到引用
  const modulePromise = import('../src/markdown/copyButtons')
  return modulePromise.then(({ installCopyButtons }) => {
    const root = document.createElement('article')
    root.innerHTML = `
      <pre><code>print("a")</code></pre>
      <pre><code>line1\nline2\nline3</code></pre>
      <table><tbody><tr><td>cell</td></tr></tbody></table>
    `
    const teardown = installCopyButtons(root, { copyLabel: '复制代码', copiedLabel: '已复制' })
    const hosts = root.querySelectorAll('.md-copy-host')
    assert.equal(hosts.length, 3, `应为 3 个宿主，实际 ${hosts.length}`)
    for (const host of Array.from(hosts)) {
      const btn = host.querySelector('.md-copy-btn')
      assert.ok(btn, '宿主里缺按钮')
      assert.equal(btn?.textContent, '复制代码')
      // 按钮宿主必须挂在 pre / table 的直接子级位置，不能塞进 <code> 里
      const parent = host.parentElement
      assert.ok(parent, '宿主没父节点')
      assert.ok(
        parent?.tagName === 'PRE' || parent?.tagName === 'TABLE',
        `宿主应挂在 pre / table 下，实际挂在 ${parent?.tagName}`,
      )
    }
    teardown()
    assert.equal(root.querySelectorAll('.md-copy-host').length, 0, 'teardown 后应清空宿主')
  })
})

console.log(`\n${passed} 通过，${failed} 失败\n`)
process.exit(failed > 0 ? 1 : 0)
