import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/*
 * GFM 规范回归集。
 *
 * 用例来自 cmark-gfm 官方的 test/spec.txt（672 条），落在 tests/fixtures 里，
 * 不联网也能跑。比对用 spec 给的期望 HTML，而不是「我们上次输出了什么」——
 * 后者只会把现状钉死，改坏了也测不出来。
 *
 * 三层：
 *   一、全体冒烟与安全：672 条都能渲染，且不留下可执行的东西。
 *   二、精确比对：可比对的那部分逐字节比，一致数不得低于基线。
 *   三、关键结构：任务列表、自动链接这些真正影响阅读的，单独断言。
 *
 * 为什么不是「全部 672 条逐字节一致」：这个阅读器在 spec 之上刻意加了两层
 * 东西（标题锚点 id、代码高亮），再叠加 DOMPurify 的安全清洗和 markdown-it
 * 自身的实现选择。硬要 100% 一致，等于逼着把安全清洗和排版能力都拆掉。
 * 真正该盯的是「文档写对了、我们渲染错了」的那类，所以基线之上还留了第三层。
 *
 * 跑：npm run test:gfm
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

const { parseSpec, normalize, isComparable } = await import('./gfm-spec')
const { renderMarkdown } = await import('../src/markdown/render')

const spec = parseSpec(readFileSync('tests/fixtures/gfm-spec.txt', 'utf8'))

/*
 * 基线：551 条可比对用例里的一致数。
 *
 * 这个数字只能往上走。往下掉了，说明某次改动把渲染改坏了 ——
 * 要么是真回归，得修；要么是新引入的刻意偏差，那就把理由写进下面的
 * ACCEPTED 说明，再把这个数字调过去。不允许默默调低。
 */
const BASELINE = 449

/*
 * 剩下那 102 条的去向，逐条看过，都归在这几类里：
 *
 * 1. 安全清洗（44 条，HTML blocks / Raw HTML / Disallowed Raw HTML）
 *    script、style 连内容一起删；<iframe>、<form>、非白名单标签剥掉；
 *    HTML 注释、<!DOCTYPE>、<?php>、<![CDATA[ 清掉；没闭合的标签补上。
 *    这是我们主动选的代价，不是偏差。
 * 2. 序列化差异（约 45 条）
 *    &quot; 与 "、&nbsp; 与空格、实体是否展开、块之间空行数量。
 *    浏览器解析结果一致，只是字符串不一样。
 * 3. 强调嵌套规则（8 条）
 *    CommonMark 0.29 改过嵌套判定，markdown-it 用的是旧规则，
 *    输出 <strong>a <strong>b</strong> c</strong> 而不是单层。
 *    视觉等价，上游行为，改不动也不必改。
 * 4. linkify 比规范更激进（7 条）
 *    foo@bar.example.com、裸 http:// 会成链，规范核心节要求不成链。
 *    这正是 GFM 扩展节要求的，实际更好用，保留。
 * 5. 表格（2 条）：markdown-it 总是输出 <tbody>，对齐用 style 而非 align 属性。
 * 6. 任务列表（2 条）：多了 contain-task-list 等样式 class，功能正确。
 * 7. 删除线（1 条）：markdown-it 输出 <s>，规范写 <del>，语义等价。
 */
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

console.log('\nGFM 规范回归集：')

test('用例源解析完整（672 条，含 Tables / Task list / Strikethrough 三个扩展章节）', () => {
  assert.equal(spec.length, 672)
  const sections = new Set(spec.map((e) => e.section))
  for (const required of [
    'Tables (extension)',
    'Task list items (extension)',
    'Strikethrough (extension)',
    'Autolinks (extension)',
  ]) {
    assert.ok(sections.has(required), `缺了 ${required} 小节`)
  }
})

test('全部用例都能渲染，且不留下可执行的东西', () => {
  for (const example of spec) {
    const html = renderMarkdown(example.markdown)
    assert.equal(typeof html, 'string', `用例 #${example.number} 渲染没返回字符串`)
    assert.ok(!/<script/i.test(html), `用例 #${example.number} 漏出了 script`)
    assert.ok(!/\son\w+=/i.test(html), `用例 #${example.number} 漏出了事件属性`)
  }
})

test('精确比对的一致数不低于基线', () => {
  let same = 0
  const regressions: number[] = []
  for (const example of spec) {
    if (!isComparable(example)) continue
    if (normalize(renderMarkdown(example.markdown)) === normalize(example.html)) same++
    else regressions.push(example.number)
  }
  assert.ok(
    same >= BASELINE,
    `一致数从 ${BASELINE} 掉到了 ${same}，回退的用例：${regressions.slice(0, 20).join(', ')}`,
  )
  console.log(`    （本次 ${same} / ${BASELINE} 基线）`)
})

console.log('\n关键结构：')

test('任务列表的复选框在（GFM 扩展）', () => {
  for (const example of spec.filter((e) => e.kind === 'tasklist')) {
    const html = renderMarkdown(example.markdown)
    assert.ok(html.includes('type="checkbox"'), `用例 #${example.number} 复选框丢了：${html}`)
  }
})

/*
 * 下面这两条只看「规范期望有」的用例。
 * 每个小节里都混着反例 —— 写歪的表格确实不该成表格、跨空行的 ~~ 确实不该
 * 成删除线。拿整节做断言会把这些反例一起算成失败。
 */
function expectAll(
  label: string,
  kind: string,
  want: (expectedHtml: string) => boolean,
  check: (html: string, number: number) => void,
): void {
  test(label, () => {
    const cases = spec.filter((e) => e.kind === kind && want(e.html))
    assert.ok(cases.length > 0, `${kind} 里一条该生效的用例都没有，spec 格式可能变了`)
    for (const example of cases) check(renderMarkdown(example.markdown), example.number)
  })
}

expectAll(
  'tables 用例都渲染出表格',
  'table',
  (html) => html.includes('<table'),
  (html, number) => assert.ok(html.includes('<table'), `用例 #${number} 没出表格：${html}`),
)

expectAll(
  '删除线用例都渲染出删除线标签',
  'strikethrough',
  (html) => html.includes('<del>'),
  (html, number) => assert.ok(/<del>|<s>/.test(html), `用例 #${number} 没出删除线：${html}`),
)

test('围栏代码块都进了 pre/code', () => {
  const fenced = spec.filter((e) => e.section === 'Fenced code blocks' && e.html.includes('<pre>'))
  assert.ok(fenced.length > 20, '围栏代码块的用例数不对，spec 格式可能变了')
  for (const example of fenced) {
    const html = normalize(renderMarkdown(example.markdown))
    assert.ok(html.includes('<pre>') && html.includes('<code'), `用例 #${example.number}`)
  }
})

console.log(`\n${passed} 通过，${failed} 失败\n`)
process.exit(failed > 0 ? 1 : 0)
