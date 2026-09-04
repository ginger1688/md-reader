import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import { highlightCode } from './highlight'
import { sanitizeHtml } from './sanitize'

/*
 * html: true —— 源文档里的裸 HTML 会被当成 HTML 解析，随后整体过 DOMPurify 白名单。
 *
 * v0.1 时这里写的是 html: false，一切裸 HTML 都被转义成文本。那样最安全，
 * 但 <details>、<kbd> 这类排版标签也一起被废掉了。现在的取舍是放通 + 清洗：
 * 能表达结构，不能执行代码。清洗规则集中在 ./sanitize.ts。
 *
 * 开 html 的代价要记清楚 —— 它是 markdown-it 切块行为的改变，白名单管不到：
 *   1. 行首出现块级标签（<div>、<table> 等）时，其后内容会被吞进同一个 HTML 块，
 *      直到空行为止。文档里写了个没闭合的 <div>，后面一大段就都在它里面了。
 *   2. HTML 块内部的 4 空格缩进代码块不再生效。
 * DOMPurify 会把没闭合的标签补上，所以结果不会崩，只是和你以为的会有出入。
 */
const md = new MarkdownIt({
  html: true,
  linkify: true, // GFM 自动链接：裸 www.xxx.com / a@b.com 自动成链
  breaks: false, // GFM 语义：单换行不断行，空行才分段
  typographer: false, // 不做引号/破折号美化，避免改写原文字符
  // 返回空串即「这个语言不认识」，markdown-it 会退回默认的转义输出。
  // 语言表必须先由 ensureLanguages 补齐，这里只能同步处理已注册的。
  highlight: (code, language) => highlightCode(code, language),
})

// 任务列表 `- [ ] / - [x]`。checkbox 保持 disabled：这是阅读器，不该在文档上改状态。
md.use(taskLists, { enabled: false })

/*
 * GFM 的自动链接扩展要求 `www.xxx.com` 这种不带协议的裸域名也成链。
 * markdown-it 的 linkify 默认只认带协议的（http://example.com），
 * 裸域名要单独开 fuzzyLink —— 少了这行，文档里最常见的那种网址反而不成链。
 */
md.linkify.set({ fuzzyLink: true })

export function renderMarkdown(source: string): string {
  // 清洗必须发生在放进 DOM 之前，中间不能有任何一处直接 innerHTML 这个结果。
  return sanitizeHtml(md.render(source))
}
