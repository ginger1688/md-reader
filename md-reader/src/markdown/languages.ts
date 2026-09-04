import type { LanguageFn } from 'highlight.js'
import { setLanguageLoader } from './highlight'

/*
 * 冷门语言的按需加载表 —— 全应用唯一一处 Vite 专有语法。
 *
 * 只做一件事：把加载器注入 ./highlight.ts。那边不认得 import.meta.glob，
 * 于是渲染链在 Node 下也能加载，可以进单测与基准。
 *
 * 副作用导入，由 main.tsx 引入一次。不要从 render.ts 或 highlight.ts 引这里，
 * 那等于把 Vite 依赖又接回渲染链上，白抽一场。
 */

/*
 * 写成显式 glob 而不是更自然的 import(`highlight.js/lib/languages/${name})，
 * 是因为后者在这里根本不生效：highlight.js 的 package.json exports 用的是
 * 通配符映射（"./lib/languages/*" → "./es/languages/*.js"），Vite 推不出静态
 * 的 glob 模式，实测结果是所有语言被静默忽略、一个分片都没生成，冷门语言
 * 只能降级成纯文本。写进 node_modules 的相对路径是拿到的代价。
 *
 * 排除两类：
 * - *.js.js 是 highlight.js 留下的废弃存根（只打印一句「别带扩展名」的警告），不含语言定义
 * - 已静态打包的 24 种，避免同一份语言在主 bundle 和分片里各存一份
 */
const languageModules = import.meta.glob<LanguageFn>(
  [
    '../../node_modules/highlight.js/es/languages/*.js',
    '!../../node_modules/highlight.js/es/languages/*.js.js',
    '!../../node_modules/highlight.js/es/languages/{bash,c,cpp,csharp,css,diff,go,ini,java,javascript,json,kotlin,markdown,php,python,rust,scss,shell,sql,swift,typescript,xml,yaml}.js',
  ],
  { import: 'default' },
)

const GLOB_PREFIX = '../../node_modules/highlight.js/es/languages/'

setLanguageLoader((name) => {
  const loader = languageModules[`${GLOB_PREFIX}${name}.js`]
  return loader ? loader() : Promise.resolve(null)
})
