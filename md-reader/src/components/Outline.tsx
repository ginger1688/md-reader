import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Heading } from '../markdown/headings'

type Props = {
  headings: Heading[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function Outline({ headings, activeId, onSelect }: Props) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const listRef = useRef<HTMLUListElement>(null)

  /// 换文档时清空折叠状态，否则上一篇的折叠会莫名其妙套到下一篇上
  useEffect(() => setCollapsed(new Set()), [headings])

  /// 高亮项跟着滚动，但只在大纲自己的视口内挪，不要连带滚动正文
  useEffect(() => {
    if (!activeId) return
    listRef.current
      ?.querySelector(`[data-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const hasChildren = useMemo(() => {
    return headings.map((heading, index) =>
      headings.slice(index + 1).some((next) => next.level > heading.level),
    )
  }, [headings])

  /// 任一祖先被折叠，自己就隐藏。只沿「父 → 祖父」这条链往上找，
  /// 不去检查所有 level 更小的标题，否则隔了层级的折叠会误伤。
  function isHidden(index: number): boolean {
    let level = headings[index].level
    for (let i = index - 1; i >= 0; i--) {
      if (headings[i].level >= level) continue
      if (collapsed.has(headings[i].id)) return true
      level = headings[i].level
      if (level === 1) break
    }
    return false
  }

  function toggle(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (headings.length === 0) {
    return (
      <nav className="outline">
        <div className="outline-head">{t('outline.title')}</div>
        <p className="outline-empty">{t('outline.empty')}</p>
      </nav>
    )
  }

  return (
    <nav className="outline">
      <div className="outline-head">{t('outline.title')}</div>

      <ul ref={listRef}>
        {headings.map((heading, index) => {
          if (isHidden(index)) return null
          const isCollapsed = collapsed.has(heading.id)

          return (
            <li key={`${heading.id}-${index}`}>
              <div className={`outline-row level-${heading.level}`}>
                {hasChildren[index] ? (
                  <button
                    className={`outline-twisty ${isCollapsed ? 'collapsed' : ''}`}
                    onClick={() => toggle(heading.id)}
                    aria-label={isCollapsed ? t('outline.expand') : t('outline.collapse')}
                    aria-expanded={!isCollapsed}
                  >
                    ▾
                  </button>
                ) : (
                  <span className="outline-twisty placeholder" />
                )}

                <button
                  className={`outline-item ${heading.id === activeId ? 'active' : ''}`}
                  data-id={heading.id}
                  onClick={() => onSelect(heading.id)}
                  title={heading.text}
                >
                  {heading.text}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
