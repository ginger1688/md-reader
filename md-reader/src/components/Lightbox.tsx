import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type GalleryImage = { src: string; name: string }

type Props = {
  images: GalleryImage[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}

type View = { scale: number; x: number; y: number }

const MIN_SCALE = 0.1
const MAX_SCALE = 16
const ZOOM_STEP = 1.15

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/// asset 地址是 http://asset.localhost/<URL 编码后的路径>，取末段还原文件名。
function nameFromSrc(src: string): string {
  try {
    const path = decodeURIComponent(new URL(src).pathname)
    return path.split(/[\\/]/).pop() ?? src
  } catch {
    return src
  }
}

export function Lightbox({ images, index, onClose, onNavigate }: Props) {
  const { t } = useTranslation()
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const stage = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const current = images[index]
  const multiple = images.length > 1

  // 换图就重置视图，否则上一篇的缩放平移会带到下一篇上。
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 })
    setSize({ width: 0, height: 0 })
  }, [index])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
      if (!multiple) return
      if (event.key === 'ArrowLeft') onNavigate((index - 1 + images.length) % images.length)
      if (event.key === 'ArrowRight') onNavigate((index + 1) % images.length)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [index, images.length, multiple, onClose, onNavigate])

  /*
   * 滚轮缩放必须用原生监听：React 的 onWheel 是 passive 的，
   * 里面调 preventDefault 会被浏览器忽略，页面会跟着一起滚。
   */
  useEffect(() => {
    const element = stage.current
    if (!element) return

    function onWheel(event: WheelEvent) {
      event.preventDefault()
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
    // 空依赖即可：zoomAt 只用到 ref 与 setView，两者引用都稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /// 以鼠标位置为锚点缩放：缩放前后，光标下的那个点应停在原处。
  function zoomAt(clientX: number, clientY: number, factor: number) {
    const element = stage.current
    if (!element) return
    const box = element.getBoundingClientRect()
    const anchorX = clientX - box.left - box.width / 2
    const anchorY = clientY - box.top - box.height / 2

    setView((previous) => {
      const scale = clamp(previous.scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = scale / previous.scale
      return {
        scale,
        x: anchorX - (anchorX - previous.x) * ratio,
        y: anchorY - (anchorY - previous.y) * ratio,
      }
    })
  }

  function zoomByButton(factor: number) {
    const element = stage.current
    if (!element) return
    const box = element.getBoundingClientRect()
    zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor)
  }

  function fitToWindow() {
    const element = stage.current
    const img = image.current
    if (!element || !img) return
    const width = img.naturalWidth || 1
    const height = img.naturalHeight || 1
    const scale = Math.min(element.clientWidth / width, element.clientHeight / height, 1)
    setView({ scale, x: 0, y: 0 })
  }

  function actualSize() {
    setView({ scale: 1, x: 0, y: 0 })
  }

  function onImageLoad() {
    const img = image.current
    if (!img) return
    setSize({ width: img.naturalWidth, height: img.naturalHeight })
    fitToWindow()
  }

  return (
    <div className="lightbox" role="dialog" aria-modal="true">
      <div
        className="lightbox-stage"
        ref={stage}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX - view.x, y: e.clientY - view.y, moved: false }
        }}
        onMouseMove={(e) => {
          if (!drag.current) return
          const start = drag.current
          // 记下是否真移动过：拖动结束时浏览器还会补一个 click，
          // 不区分的话「拖完图就关掉灯箱」会变成必现 bug。
          start.moved = true
          setView((v) => ({ ...v, x: e.clientX - start.x, y: e.clientY - start.y }))
        }}
        onMouseUp={() => {
          drag.current = null
        }}
        onMouseLeave={() => {
          drag.current = null
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !drag.current?.moved) onClose()
        }}
      >
        <img
          ref={image}
          className="lightbox-image"
          src={current.src}
          alt={current.name}
          draggable={false}
          onLoad={onImageLoad}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            cursor: drag.current ? 'grabbing' : 'grab',
          }}
        />
      </div>

      <div className="lightbox-bar">
        <span className="lightbox-name" title={nameFromSrc(current.src)}>
          {nameFromSrc(current.src)}
        </span>
        <span className="lightbox-meta">
          {size.width > 0
            ? `${size.width} × ${size.height} · ${Math.round(view.scale * 100)}%`
            : `${Math.round(view.scale * 100)}%`}
        </span>

        <div className="lightbox-actions">
          {multiple && (
            <>
              <button
                onClick={() => onNavigate((index - 1 + images.length) % images.length)}
                aria-label={t('lightbox.previous')}
              >
                ‹
              </button>
              <span className="lightbox-count">
                {index + 1} / {images.length}
              </span>
              <button
                onClick={() => onNavigate((index + 1) % images.length)}
                aria-label={t('lightbox.next')}
              >
                ›
              </button>
            </>
          )}

          <button onClick={() => zoomByButton(1 / ZOOM_STEP)} aria-label={t('lightbox.zoomOut')}>
            −
          </button>
          <button onClick={() => zoomByButton(ZOOM_STEP)} aria-label={t('lightbox.zoomIn')}>
            +
          </button>
          <button onClick={fitToWindow}>{t('lightbox.fit')}</button>
          <button onClick={actualSize}>{t('lightbox.actualSize')}</button>
          <button onClick={onClose}>{t('lightbox.close')}</button>
        </div>
      </div>
    </div>
  )
}
