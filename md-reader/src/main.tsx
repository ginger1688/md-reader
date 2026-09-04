import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// 副作用导入：初始化 i18next（首次读取语言、写入 <html lang>）。
import './i18n'
// 副作用导入：把冷门语言的按需加载器注入 highlight.ts。
// 必须在这里引 —— 它是全应用唯一一处 Vite 专有语法，从 render.ts 引会把
// 渲染链重新焊死在 Vite 上，Node 下就又加载不了了。
import './markdown/languages'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
