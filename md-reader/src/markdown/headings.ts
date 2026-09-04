export type Heading = {
  level: number
  text: string
  id: string
}

/*
 * 给标题生成 id。
 *
 * 保留中文：大纲跳转用的是 document.getElementById，不走 URL 的 hash 路由，
 * 没必要把中文转成拼音或丢弃。空格与标点去掉即可。
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    // 空格先转连字符（同 GitHub 的做法），再清掉其余标点。
    // 顺序不能反：先清标点的话空格就没了，「Hello World」会挤成 helloworld。
    .replace(/\s+/g, '-')
    // 保留字母、数字、下划线、连字符与中日韩统一表意文字
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/*
 * 生成一个不撞车的 id。
 *
 * 要避让两样东西：
 *   1. 前面已处理过的同名标题 —— 同名加序号，否则跳转永远跳到第一个
 *   2. 文档里本来就带 id 的元素 —— 白名单放行了 id 属性，文档里完全可能有
 *      <div id="说明">。标题若也用这个名字，document.getElementById 会先取到
 *      那个 div，大纲跳转与滚动高亮就都指错人了。
 */
function uniqueId(base: string, element: HTMLElement, used: Set<string>): string {
  let candidate = base
  let suffix = 0
  while (used.has(candidate) || takenByOther(candidate, element)) {
    suffix++
    candidate = `${base}-${suffix}`
  }
  used.add(candidate)
  return candidate
}

/// element 此刻还没写 id，所以只要查出东西来，那一定不是它。
function takenByOther(id: string, element: HTMLElement): boolean {
  const owner = document.getElementById(id)
  return owner !== null && owner !== element
}

/*
 * 提取标题、写回 id，并返回大纲数据。
 *
 * 在 innerHTML 落地之后跑：markdown-it 默认不给标题生成 id，
 * 而逐 token 处理要深入它的内部规则，直接操作渲染好的 DOM 更简单。
 * 每次文档变化都会重建 DOM，所以重新跑一遍即可，不用考虑幂等。
 */
export function collectHeadings(root: HTMLElement): Heading[] {
  const headings: Heading[] = []
  const used = new Set<string>()

  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((element) => {
    const level = Number(element.tagName[1])
    const text = element.textContent?.trim() ?? ''

    // 文档自己写了 id 就以它为准 —— 作者多半是拿它当锚点用的，覆盖掉会
    // 让文里的 [跳转](#xxx) 失联。没写才从标题文本生成。
    // 两种情况都还要再避让一遍已存在的 id。
    element.id = uniqueId(element.id || slugify(text), element, used)
    headings.push({ level, text, id: element.id })
  })

  return headings
}

/// 找出当前应高亮的标题：视口顶部之上、离顶部最近的那个。
/// 传入滚动容器，用两者的 getBoundingClientRect 差值算，
/// 不依赖 offsetTop（那需要容器恰好是 offsetParent）。
export function findActiveHeading(headings: Heading[], container: HTMLElement): string | null {
  if (headings.length === 0) return null

  const containerTop = container.getBoundingClientRect().top
  let active: string | null = headings[0].id

  for (const heading of headings) {
    const element = document.getElementById(heading.id)
    if (!element) continue
    if (element.getBoundingClientRect().top - containerTop <= 8) {
      active = heading.id
    } else {
      break
    }
  }

  return active
}
