import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'

/// Rust list_directory 返回的目录项。前端 serde 解出来的字段名要与之对应。
type DirEntry = {
  name: string
  path: string
  is_dir: boolean
}

/*
 * 文件树节点。
 *
 * v0.3 第一版只做「两层结构」：根目录 + 它的直接子项。
 * 不递归展开的原因：
 *   - 大目录（上千个 md）一次性拉全树要十几秒，慢到能感知
 *   - 用户实际打开一篇文档后，最常用的是「切到相邻的下一篇」，一两层就够
 *   - 真要下钻再调一次 list_directory，UI 上加个展开箭头即可
 *
 * 未来想做成全树的话，把 children 改成按需加载的 union 类型即可，
 * 接口已经为它留好了 shape。
 */
type TreeNode = {
  entry: DirEntry
  children?: TreeNode[]
}

type Props = {
  root: string | null
  /// 当前打开文件的路径，用于在大纲/文件树里高亮。null 表示还没有打开任何文件。
  currentSource: string | null
  /// 用户选中一个文件。
  onSelect: (path: string) => void
}

/*
 * 列出一层。
 *
 * invoke 失败时（路径无效、权限不足）返回空数组 —— 调用方会展示空状态，
 * 避免一次失败炸掉整棵树。同时也防止 `root` 在切换时短暂指向旧路径导致读不到。
 */
async function loadLayer(path: string): Promise<TreeNode[]> {
  try {
    const items = await invoke<DirEntry[]>('list_directory', { path })
    return items.map((entry) => ({ entry }))
  } catch {
    return []
  }
}

export function FileTree({ root, currentSource, onSelect }: Props) {
  const { t } = useTranslation()
  const [nodes, setNodes] = useState<TreeNode[]>([])

  useEffect(() => {
    if (!root) {
      setNodes([])
      return
    }
    let cancelled = false
    loadLayer(root).then((layer) => {
      if (!cancelled) setNodes(layer)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  if (!root) {
    return (
      <nav className="file-tree">
        <div className="file-tree-head">{t('folder.title')}</div>
        <p className="file-tree-empty">{t('folder.empty')}</p>
      </nav>
    )
  }

  if (nodes.length === 0) {
    return (
      <nav className="file-tree">
        <div className="file-tree-head">{t('folder.title')}</div>
        <p className="file-tree-empty">{t('folder.noEntries')}</p>
      </nav>
    )
  }

  return (
    <nav className="file-tree">
      <div className="file-tree-head" title={root}>
        {t('folder.title')} · {root.split(/[\\/]/).pop() ?? root}
      </div>
      <ul>
        {nodes.map((node) => (
          <TreeRow key={node.entry.path} node={node} currentSource={currentSource} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  )
}

/*
 * 单行渲染：图标 + 文件名。文件夹和文件用不同颜色 / 符号区分，
 * 但所有节点都可点击 —— 点文件夹不打开，只是不响应到 doc 切换。
 *
 * 当前打开的文件用 active 类，色与大纲高亮一致。
 */
function TreeRow({
  node,
  currentSource,
  onSelect,
}: {
  node: TreeNode
  currentSource: string | null
  onSelect: (path: string) => void
}) {
  const isActive = node.entry.path === currentSource
  return (
    <li>
      <button
        className={`file-tree-row ${isActive ? 'active' : ''}`}
        // 目录不响应「打开」语义 —— 点击只是折叠/展开的未来占位，目前不可点。
        // 用 disabled 而非忽略 click：避免用户期望点击行为而按下去没反应。
        disabled={node.entry.is_dir}
        onClick={node.entry.is_dir ? undefined : () => onSelect(node.entry.path)}
      >
        <span className="file-tree-icon" aria-hidden="true">
          {node.entry.is_dir ? '▸' : '•'}
        </span>
        <span className="file-tree-name">{node.entry.name}</span>
      </button>
    </li>
  )
}