import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

// 常用语言：静态打包进主 bundle，保证首屏渲染不需要任何异步加载。
// 这 24 种覆盖了日常 95% 的代码块，其余语言走下面的动态加载。
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const PRELOADED: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

for (const [name, definition] of Object.entries(PRELOADED)) {
  // registerLanguage 会一并注册语言自带的别名（注册 javascript 后 'js'、'jsx' 即可用）。
  hljs.registerLanguage(name, definition)
}

/*
 * 别名 → 文件名。
 *
 * 只覆盖「动态加载」这一条路径：预加载语言的别名 hljs 自己认得，
 * 但冷门语言在文件下载之前 hljs 还不认识它，别名无从解析，只能查这张表。
 *
 * 表里只收常见写法。漏掉的语言会退回用原名加载——而多数语言的常用名
 * 恰好就是文件名（perl、ruby、elixir…），所以漏一两个不影响可用性。
 */
const ALIAS_TO_FILE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'shell',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  'c#': 'csharp',
  golang: 'go',
  json5: 'json',
  jsonc: 'json',
  docker: 'dockerfile',
  toml: 'ini',
  patch: 'diff',
  tex: 'latex',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  pl: 'perl',
  ps1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  ex: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
}

/*
 * 冷门语言的按需加载。
 *
 * 加载器由外部注入（见 ./languages.ts），本文件不碰 import.meta.glob 之类的
 * 构建期语法 —— 那会让整个渲染链在 Node 下加载即报错，测不了也benchmark不了。
 * 没注入时（测试环境）冷门语言直接降级为纯文本，正好是测试不关心的那部分。
 */
type LanguageLoader = (name: string) => Promise<LanguageFn | null>

let loadModule: LanguageLoader = () => Promise.resolve(null)

/// 由 languages.ts 在应用启动时调用一次。重复注入以最后一次为准。
export function setLanguageLoader(loader: LanguageLoader): void {
  loadModule = loader
}

/// 正在加载 / 已加载的语言，避免同一个语言被并发请求多次。
const loading = new Map<string, Promise<boolean>>()

function loadLanguage(name: string): Promise<boolean> {
  const inflight = loading.get(name)
  if (inflight) return inflight

  const task = loadModule(name).then((definition) => {
    // 拿不到定义就降级为不高亮，不打断渲染
    if (!definition) return false
    hljs.registerLanguage(name, definition)
    return true
  })

  loading.set(name, task)
  return task
}

/// 把 Markdown 源码里出现的所有语种补齐注册。渲染前调用一次即可。
export async function ensureLanguages(languages: string[]): Promise<void> {
  const missing = [...new Set(languages)].filter((name) => !hljs.getLanguage(name))
  await Promise.all(missing.map((name) => loadLanguage(ALIAS_TO_FILE[name] ?? name)))
}

/// 从源码里抓出所有围栏代码块的语种标注（``` 与 ~~~ 都算）。
export function detectCodeLanguages(markdown: string): string[] {
  const found = new Set<string>()
  const fence = /^[ \t]{0,3}(?:```+|~~~+)[ \t]*([^\s`]+)/gm
  for (const match of markdown.matchAll(fence)) {
    found.add(match[1].toLowerCase())
  }
  return [...found]
}

/// 返回高亮后的 HTML；返回空串表示「这个语言不认识」，交给 markdown-it 默认转义输出。
export function highlightCode(code: string, language: string): string {
  const resolved = hljs.getLanguage(language)
    ? language
    : ALIAS_TO_FILE[language] && hljs.getLanguage(ALIAS_TO_FILE[language])
      ? ALIAS_TO_FILE[language]
      : null

  if (!resolved) return ''

  try {
    // ignoreIllegals：遇非法语法不要抛错，宁可少高亮几个 token 也别整体失败。
    return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
  } catch {
    return ''
  }
}
