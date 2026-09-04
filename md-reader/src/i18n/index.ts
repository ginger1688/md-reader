import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

export const LANGS = ['zh-CN', 'en-US'] as const
export type Lang = (typeof LANGS)[number]

const STORAGE_KEY = 'md-reader:language'

function loadStored(): Lang | null {
  const saved = localStorage.getItem(STORAGE_KEY)
  return LANGS.find((lang) => lang === saved) ?? null
}

/// 没有手动选择过就跟随系统语言：凡是 zh 开头的（zh、zh-CN、zh-Hans、zh-TW…）都归到简体中文。
function detectSystem(): Lang {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function setLang(lang: Lang): void {
  localStorage.setItem(STORAGE_KEY, lang)
  document.documentElement.lang = lang
  // changeLanguage 返回 Promise，但调用方不需要等它；
  // 用它触发 react-i18next 的订阅重渲染即可。
  void i18next.changeLanguage(lang)
}

void i18next.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: loadStored() ?? detectSystem(),
  fallbackLng: 'en-US',
  // React 渲染时本身就会转义，i18next 再转一次会显示成 &amp; 这类实体。
  interpolation: { escapeValue: false },
})

document.documentElement.lang = i18next.language
