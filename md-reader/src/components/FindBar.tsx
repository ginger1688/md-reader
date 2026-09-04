import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  query: string
  onQuery: (value: string) => void
  matchCount: number
  currentIndex: number
  caseSensitive: boolean
  wholeWord: boolean
  onToggleCase: () => void
  onToggleWord: () => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function FindBar({
  query,
  onQuery,
  matchCount,
  currentIndex,
  caseSensitive,
  wholeWord,
  onToggleCase,
  onToggleWord,
  onNext,
  onPrevious,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <div className="findbar">
      <input
        ref={input}
        className="find-input"
        value={query}
        placeholder={t('find.placeholder')}
        onChange={(e) => onQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrevious()
            else onNext()
          }
          if (e.key === 'Escape') onClose()
        }}
      />

      <span className="find-count">
        {query && matchCount === 0
          ? t('find.noMatch')
          : query
            ? `${currentIndex + 1} / ${matchCount}`
            : ''}
      </span>

      <button onClick={onPrevious} disabled={matchCount === 0} aria-label={t('find.previous')}>
        ↑
      </button>
      <button onClick={onNext} disabled={matchCount === 0} aria-label={t('find.next')}>
        ↓
      </button>

      <button
        className={`find-toggle ${caseSensitive ? 'on' : ''}`}
        onClick={onToggleCase}
        title={t('find.caseSensitive')}
      >
        Aa
      </button>
      <button
        className={`find-toggle ${wholeWord ? 'on' : ''}`}
        onClick={onToggleWord}
        title={t('find.wholeWord')}
      >
        [ab]
      </button>

      <button onClick={onClose} aria-label={t('find.close')}>
        ✕
      </button>
    </div>
  )
}
