/*
 * 生成性能闸门用的大素材：一份 5 MB 的 Markdown，一张 10 MB 的 PNG。
 *
 * 存在的理由：PRD §7 里 v0.2 的出口条件写着「5 MB 文档滚动 60 fps」
 * 和「10 MB 图灯箱打开 ≤ 500 ms」，但仓库里只有几 KB 的手写样例，
 * 这两条根本没法测。素材本身也是产物的一部分 —— 没有它，闸门就是一句口号。
 *
 * 确定性：用固定种子的 mulberry32，重复生成字节完全一致，
 * 这样不同次测量的数字才有可比性。
 *
 * 用法：npm run fixtures
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '测试样例')

const DOC_TARGET = 5 * 1024 * 1024
const IMAGE_TARGET = 10 * 1024 * 1024

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  '渲染', '解析', '偏移', '视口', '高亮', '编码', '字节', '缓冲', '列宽', '锚点',
  '分块', '滚动', '折叠', '转义', '白名单', '清洗', '懒加载', '换行', '宽度', '层级',
  '章节', '段落', '表格', '公式', '图表', '灯箱', '大纲', '进度', '配色', '主题',
]

function sentence(rand: () => number, count: number): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    parts.push(WORDS[Math.floor(rand() * WORDS.length)])
  }
  return parts.join('')
}

/// 一段带行内标记的正文。行内元素会让 TreeWalker 摊平出的 chunk 变多，
/// 这是查找路径上最容易被压出来的地方，素材里不能只有纯段落。
function paragraph(rand: () => number, index: number): string {
  const a = sentence(rand, 6)
  const b = sentence(rand, 5)
  const c = sentence(rand, 7)
  const d = sentence(rand, 4)
  return [
    `这是第 ${index} 段的正文，用来把文档撑到目标体积。`,
    `这里有一处**加粗**和一处*斜体*，还有一处 \`行内代码\`，`,
    `以及一个[外部链接](https://example.com/doc/${index})。`,
    `${a}，${b}；${c}。`,
    `再来一句带~~删除线~~与${d}的收尾，保证行内元素足够密。`,
  ].join('')
}

function table(rand: () => number, index: number): string {
  const rows = ['| 编号 | 名称 | 类型 | 说明 | 权重 |', '| --- | --- | --- | --- | ---: |']
  for (let r = 0; r < 8; r++) {
    rows.push(
      `| ${index * 10 + r} | ${sentence(rand, 2)} | ${sentence(rand, 1)} | ` +
        `${sentence(rand, 4)} | ${(rand() * 100).toFixed(1)} |`,
    )
  }
  return rows.join('\n')
}

const LANGS = ['ts', 'python', 'rust', 'bash', 'json', 'sql']

function codeBlock(rand: () => number, index: number): string {
  const lang = LANGS[index % LANGS.length]
  const lines = ['```' + lang]
  for (let i = 0; i < 14; i++) {
    lines.push(
      `const value_${i} = compute(${index}, ${i}, "${sentence(rand, 2)}")  // ${sentence(rand, 3)}`,
    )
  }
  lines.push('```')
  return lines.join('\n')
}

function taskList(rand: () => number): string {
  return [
    `- [x] ${sentence(rand, 4)}`,
    `- [ ] ${sentence(rand, 5)}`,
    `- [ ] ${sentence(rand, 3)}`,
  ].join('\n')
}

/// 一节的内容。目标体积靠节数凑，每节约 40 KB。
function section(rand: () => number, index: number): string {
  return [
    `## 第 ${index} 节 · ${sentence(rand, 3)}`,
    '',
    paragraph(rand, index * 3),
    '',
    `### ${sentence(rand, 4)}`,
    '',
    paragraph(rand, index * 3 + 1),
    '',
    table(rand, index),
    '',
    codeBlock(rand, index),
    '',
    taskList(rand),
    '',
    `> ${sentence(rand, 8)}`,
    '',
    // 图片刻意稀疏：每 10 节一张。每张 SVG 都要单独解析一遍，
    // 密度一高，滚动测量测的就是图片解码而不是排版了。
    ...(index % 10 === 0 ? [`![配图 ${index}](sample-image.svg)`, ''] : []),
    paragraph(rand, index * 3 + 2),
    '',
  ].join('\n')
}

function buildDoc(): string {
  const rand = mulberry32(20260903)
  const chunks: string[] = [
    '# 大文档性能样例（5 MB）',
    '',
    '> 由 `npm run fixtures` 生成，用于测量「5 MB 文档滚动 60 fps」。',
    '> 内容含标题层级、表格、代码围栏、任务列表、引用与行内标记，',
    '> 覆盖查找与大纲两条路径上最容易变慢的结构。',
    '',
  ]
  let size = Buffer.byteLength(chunks.join('\n'))
  let index = 0
  while (size < DOC_TARGET) {
    const text = section(rand, index)
    chunks.push(text)
    size += Buffer.byteLength(text)
    index++
  }
  return chunks.join('\n')
}

// --- PNG ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/*
 * 一张真彩 PNG，像素是伪随机噪声。
 *
 * 为什么是噪声而不是渐变：deflate 压不动噪声，文件体积几乎等于
 * 宽 × 高 × 3，体积可预测；渐变会被压到几百 KB，凑不到 10 MB。
 * 而且真实照片的解码成本也按像素数算，10 MB 的噪声 PNG 约等于
 * 1000 万像素，跟一张高分辨率照片同一量级。
 *
 * 用真 PNG 而不是 BMP：BMP 也能凑体积，但解码路径和真实素材差太远，
 * 测出来的数没有参考价值。
 */
function buildPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  const rand = mulberry32(0x5eed)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: None
    for (let x = 0; x < width * 3; x++) {
      raw[rowStart + 1 + x] = Math.floor(rand() * 256)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  // 10/11/12 默认 0：deflate / filter method 0 / 非隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const doc = buildDoc()
  const docPath = join(OUT_DIR, '大文档-5MB.md')
  writeFileSync(docPath, doc, 'utf8')

  // 反推尺寸：体积 ≈ 宽 × 高 × 3，按 16:9 取宽高
  const pixels = IMAGE_TARGET / 3
  const height = Math.round(Math.sqrt((pixels * 9) / 16))
  const width = Math.round((height * 16) / 9)
  const png = buildPng(width, height)
  const pngPath = join(OUT_DIR, '大图-10MB.png')
  writeFileSync(pngPath, png)

  // 灯箱用的入口文档单独一份：5 MB 那份若引用大图，
  // 滚动测量会被一次 10 MB 图片解码污染，两个数都测不准。
  const lightboxDoc = [
    '# 灯箱性能样例（10 MB 图）',
    '',
    '> 由 `npm run fixtures` 生成，用于测量「10 MB 图灯箱打开 ≤ 500 ms」。',
    '> 单独成文，避免与 5 MB 文档的滚动测量互相干扰。',
    '',
    `![大图](大图-10MB.png)`,
    '',
  ].join('\n')
  const lightboxPath = join(OUT_DIR, '灯箱-10MB图.md')
  writeFileSync(lightboxPath, lightboxDoc, 'utf8')

  const mb = (n: number) => (n / 1024 / 1024).toFixed(2) + ' MB'
  console.log(`文档       ${docPath}`)
  console.log(`  ${Buffer.byteLength(doc)} 字节 (${mb(Buffer.byteLength(doc))})`)
  console.log(`图片       ${pngPath}`)
  console.log(`  ${png.length} 字节 (${mb(png.length)})，${width} × ${height}`)
  console.log(`灯箱文档   ${lightboxPath}`)
}

main()
