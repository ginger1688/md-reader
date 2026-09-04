import DOMPurify, { type Config } from 'dompurify'

/*
 * 源文档里裸 HTML 的清洗白名单。
 *
 * 背景：v0.1 为了安全把 markdown-it 的 html 关掉了，代价是 <details>、<kbd>
 * 这类排版标签全被转义成文本。现在改成「放通 + 清洗」：markdown-it 开 html，
 * 原样吐出 HTML，再整体过一遍 DOMPurify，只留下白名单里的标签和属性。
 *
 * 为什么是白名单而不是直接开 html：
 *   阅读器会打开别人给的 .md。放通 HTML 等于把「打开一个文件」变成
 *   「运行一份代码」。白名单把能力收在「排版」这一件事上 —— 能表达结构，
 *   不能执行、不能外联、不能提交。
 */

/*
 * 允许的标签。刻意只覆盖排版与内嵌媒体，其余一律剥掉。
 *
 * 新增标签必须显式加到这张表 —— 这是白名单相对于黑名单的核心价值：
 * 每放开一个能力都要过一遍人。
 */
const ALLOWED_TAGS = [
  // 分节与标题
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  // 块级容器
  'p', 'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'blockquote', 'figure', 'figcaption', 'pre', 'br', 'wbr',
  // 行内语义
  'a', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'code', 'kbd', 'samp', 'var', 'q', 'cite', 'abbr', 'dfn', 'time',
  // 列表
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // 表格
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // 折叠（GFM 之外最常用的排版标签，也是这轮放开的主要动因）
  'details', 'summary',
  // 内嵌媒体
  'img', 'picture', 'source', 'video', 'audio', 'track',
  // 任务列表的复选框。放通它只为这一个用途，约束见下面的 installHooks。
  'input',
]

/*
 * 允许的属性。
 *
 * style 是刻意放行的：技术文档里的对齐、宽高、颜色几乎都写在 style 上，
 * 禁掉会让排版塌掉。DOMPurify 会用 CSSOM 把 style 清洗一遍，url() 外链
 * 这类取巧写法会被拦掉，剩下的只是排版属性。
 *
 * id 放行是为了内部锚点，但它会和标题锚点抢名字 —— 见 headings.ts 里的
 * 冲突处理，那里会给后生成的标题 id 加序号。
 *
 * on* 事件属性一个都不在表里，DOMPurify 也会无条件拦掉它们。
 */
const ALLOWED_ATTR = [
  'class', 'id', 'style', 'title', 'lang', 'dir',
  'hidden', 'open', 'cite', 'datetime',
  'href', 'target', 'rel', 'name',
  'src', 'srcset', 'alt', 'width', 'height', 'loading',
  'poster', 'controls', 'loop', 'muted', 'autoplay', 'preload', 'type',
  // 复选框状态
  'checked', 'disabled',
  'colspan', 'rowspan', 'align', 'valign', 'scope', 'headers', 'span',
  'start', 'reversed',
]

/*
 * 第二道闸。上面是白名单，理论上够用，但 style / form 这类一旦漏进来
 * 后果偏重，再显式压一遍，成本几乎为零。
 *
 * input 不在这张表里 —— 它要靠 ALLOWED_TAGS 放通（任务列表要用），
 * 范围由下面的 afterSanitizeAttributes 钩子收死，只留复选框。
 *
 * 注意 style 在这里是「标签」：内联 style 属性允许，<style> 元素禁止 ——
 * 后者能 @import 外部样式、也能做覆盖式视觉劫持。
 */
const FORBID_TAGS = [
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'form', 'textarea', 'select', 'option',
  'button', 'link', 'meta', 'base', 'marquee', 'bgsound',
]

const CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS,
  // 收窄面：data-* / aria-* 这个阅读器用不上，留给将来需要时再开
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // 剥掉标签时保留里面的文字，而不是整段消失。
  //
  // 例外是 <script> 与 <style>：DOMPurify 内部有一份 FORBID_CONTENTS 集合，
  // 列在里面的标签被移除时**连内容一并丢弃**，KEEP_CONTENT 对它们无效。
  // 这是实测出来的行为（见 tests/core.test.ts 的「连内容一起消失」），
  // 也是我们想要的结果 —— 没人想看见一大段脚本源码糊在正文里。
  KEEP_CONTENT: true,
  // 清洗的是 HTML 片段，不是完整文档
  WHOLE_DOCUMENT: false,
  // 返回字符串，不就地修改、不返回 DOM。
  // RETURN_TRUSTED_TYPE 显式写死：置 true 时 sanitize 返回 TrustedHTML，
  // 而我们后面要把它交给 dangerouslySetInnerHTML，必须是字符串。
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_TRUSTED_TYPE: false,
  /*
   * 放行不认识的协议。
   *
   * DOMPurify 默认只认 http/https/ftp/mailto/tel 等寥寥几个，其余
   * scheme:... 一律剥掉。对表单类应用那是对的，但会误伤 CommonMark 的
   * 自动链接：<irc://...>、<localhost:5001/foo> 写出来是对的，
   * 洗完之后只剩一个没有 href 的空 <a>，点了没反应。
   * 规范允许任意 2–32 字符的协议名，浏览器也是这么处理的，这里对齐。
   *
   * 安全性不是靠这个开关丢掉的：DOMPurify 在放行未知协议前还有一道
   * IS_SCRIPT_OR_DATA 检查，javascript: / vbscript: / data: 以及任何
   * 以 script 结尾的协议仍然被拦住。img 的 data: 内联图片另有
   * ADD_DATA_URI_TAGS 兜着，不受影响。
   * 回归用例见 tests/core.test.ts 的「未知协议」一节。
   */
  ALLOW_UNKNOWN_PROTOCOLS: true,
}

/// 复选框允许保留的属性。class 是 markdown-it-task-lists 加的，样式靠它。
const CHECKBOX_ATTRS = new Set(['type', 'checked', 'disabled', 'class'])

let hooksInstalled = false

/*
 * 把 input 收死成「只能是任务列表的复选框」。
 *
 * 白名单放通 input 是被逼的：GFM 任务列表的勾选框就是个 <input>，
 * 不放通的话整份文档里所有 `- [ ] 待办` 都会只剩文字。
 * 但 input 是个大口子，所以再用钩子收一道 —— 不是 checkbox 的整个删掉，
 * 是 checkbox 的也只留四个属性。
 *
 * 为什么连 type=text 都要删：没有 <form>（已禁）它确实提交不出去，
 * 但 <input type="file"> 能在页面里弹出系统文件对话框，
 * 不该由一份别人给的文档触发。
 */
function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'INPUT') return
    const element = node as Element
    if (element.getAttribute('type') !== 'checkbox') {
      element.parentNode?.removeChild(element)
      return
    }
    for (const name of element.getAttributeNames()) {
      if (!CHECKBOX_ATTRS.has(name.toLowerCase())) element.removeAttribute(name)
    }
  })
}

/*
 * SVG 与 MathML 暂未放通。
 *
 * 内联 SVG 是真实存在的用法（流程图、badge），但这一轮没有功能依赖它，
 * 先收着。**批次 2 做 Mermaid 与 KaTeX 时必须回来开**，否则图表和公式
 * 会被整块剥掉 —— 到那时用 USE_PROFILES: { svg: true, mathMl: true }
 * 补进来即可，记得同步补验收样例。
 */
export function sanitizeHtml(dirtyHtml: string): string {
  installHooks()
  return DOMPurify.sanitize(dirtyHtml, CONFIG)
}
