/*
 * GFM 官方 spec 用例的解析器。
 *
 * 用例源文件是 cmark-gfm 仓库里的 test/spec.txt，格式固定：
 *
 *   ```````````````````````````````` example
 *   <Markdown 源>
 *   .
 *   <期望 HTML>
 *   ````````````````````````````````
 *
 * 两个坑：
 * 1. 制表符在 spec 里写作 →（U+2192），是为了肉眼可辨。
 *    不还原成 \t 的话，「Tabs」那一整节测的都是错的东西。
 * 2. 小节名不在用例块里，而是块前面最近的那个 ## 标题，得自己往上找。
 */

export type SpecExample = {
  number: number
  section: string
  /// 用例头上的标签，例如 table / tasklist / strikethrough；普通用例为空
  kind: string
  markdown: string
  html: string
}

/*
 * 用例头形如 `````` example``，但 GFM 的扩展章节会带一个标签，
 * 写作 `````` example table`` / ``example tasklist`` / ``example strikethrough``。
 * 只认裸 example 的话，Tables、Task list items、Strikethrough 三节会被整节漏掉 ——
 * 而这三节恰恰是这个阅读器最该覆盖的部分。标签留下来当分类用。
 */
const FENCE = /^(`{20,}) example(\s+(\S+))?\s*$/

export function parseSpec(text: string): SpecExample[] {
  const lines = text.split('\n')
  const examples: SpecExample[] = []
  let section = ''

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const heading = /^#{2,3}\s+(.*\S)\s*$/.exec(line)
    if (heading && !FENCE.test(line)) {
      section = heading[1]
      index++
      continue
    }
    if (!FENCE.test(line)) {
      index++
      continue
    }

    const head = FENCE.exec(line)
    if (!head) {
      index++
      continue
    }

    const fence = head[1]
    const body: string[] = []
    index++
    while (index < lines.length && lines[index] !== fence) {
      body.push(lines[index])
      index++
    }
    index++ // 跳过闭合围栏

    const split = body.indexOf('.')
    if (split < 0) continue
    examples.push({
      number: examples.length + 1,
      section,
      kind: head[3] ?? '',
      markdown: body.slice(0, split).join('\n').replace(/→/g, '\t'),
      html: body.slice(split + 1).join('\n'),
    })
  }

  return examples
}

/*
 * 把渲染结果与 spec 期望值都归一化，再比对。
 *
 * 我们不追求与 spec 逐字节一致 —— 这个阅读器在 spec 之上加了两层东西，
 * 逐字节比对会把大量「刻意的不同」报成失败，噪音盖过信号：
 *
 * 1. 标题 id。headings.ts 给每个标题加锚点 id，spec 的期望里没有。
 * 2. 代码高亮。围栏代码块会被 highlight.js 拆成带 hljs-* 类的 span。
 *
 * 所以归一化抹掉这两类差异，剩下的才是真正值得看的偏离。
 */
/*
 * 两处刻意的不同，比对前抹掉：
 *
 * 1. 标题锚点 id。headings.ts 给每个标题加 id，spec 的期望里没有。
 * 2. 代码高亮。围栏代码块会被 highlight.js 拆成带 hljs-* 类的 span。
 *
 * 另外 spec 的期望值是 XHTML（<hr />、<img ... />），markdown-it 默认吐 HTML5
 * （<hr>、<img ...>）。规范上讲前者也只是 spec 为了自身比对方便选的序列化格式，
 * 浏览器解析结果完全一致，所以把自闭合斜杠一并抹掉。
 *
 * 抹掉这三类之后还不一致的，才是真正值得逐条看的偏离。
 */
export function normalize(html: string): string {
  return html
    // 标题锚点 id
    .replace(/<(h[1-6])\s+id="[^"]*"/g, '<$1')
    // highlight.js 注入的 span 与 class，只留下里面的文字
    .replace(/<span class="hljs[^"]*">([\s\S]*?)<\/span>/g, '$1')
    .replace(/ class="hljs[^"]*"/g, '')
    .replace(/ data-highlighted="[^"]*"/g, '')
    // XHTML 自闭合 → HTML5
    .replace(/\s*\/>/g, '>')
    // 空白：块之间的换行数量 markdown-it 与 spec 不一定一致
    .replace(/\s+/g, ' ')
    .trim()
}

/// 这两类用例不做精确比对：代码块会被高亮拆开，标题会多出 id。
export function isComparable(example: SpecExample): boolean {
  return !example.html.includes('<pre>') && !/<h[1-6][ >]/.test(example.html)
}
