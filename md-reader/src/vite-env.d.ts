/// <reference types="vite/client" />

// markdown-it-task-lists 2.x 只发布 CommonJS，没有自带类型声明。
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'

  interface TaskListsOptions {
    /// checkbox 是否可点击。阅读器里固定给 false：不应在只读文档上改状态。
    enabled?: boolean
    /// 是否把条目文字包进 <label>，从而点击文字也能切换 checkbox。
    label?: boolean
    /// label 是否追加在 checkbox 之后。
    labelAfter?: boolean
  }

  const taskLists: MarkdownIt.PluginWithOptions<TaskListsOptions>
  export default taskLists
}
