# GFM 渲染验收样例

这份文件用来验收 GFM 渲染。下面每一节对应一条验收项。

## 1. 标题层级

# 一级标题

## 二级标题

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

## 2. 行内强调

普通文本、**加粗**、*斜体*、***粗斜体***、~~删除线~~、`行内代码`、转义的 \*星号\*。

## 3. 列表

无序列表：

- 第一项
- 第二项
  - 嵌套项 A
  - 嵌套项 B
    - 三层嵌套
- 第三项

有序列表：

1. 第一步
2. 第二步
   1. 子步骤 2.1
   2. 子步骤 2.2
3. 第三步

## 4. 任务列表（GFM）

- [x] 已完成的任务
- [ ] 未完成的任务
- [ ] 另一项未完成的任务

## 5. 表格

| 模块 | 状态 | 批次 | 说明 |
| --- | --- | --- | --- |
| 文件关联打开 | 已实现 | v0.1 | 双击 .md 直接打开 |
| 大纲目录 | 未开始 | v0.2 | 从标题层级生成 |
| 代码高亮 | 未开始 | v0.2 | 引入 highlight.js |
| 文件库侧栏 | 未开始 | v0.3 | 需要 fs 插件 |

宽表（应当出现横向滚动条，而不是撑破页面）：

| 序号 | 列 A | 列 B | 列 C | 列 D | 列 E | 列 F | 列 G | 列 H | 列 I | 列 J | 列 K | 列 L |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | aaaaaaaa | bbbbbbbb | cccccccc | dddddddd | eeeeeeee | ffffffff | gggggggg | hhhhhhhh | iiiiiiii | jjjjjjjj | kkkkkkkk | llllllll |
| 2 | mmmmmmmm | nnnnnnnn | oooooooo | pppppppp | qqqqqqqq | rrrrrrrr | ssssssss | tttttttt | uuuuuuuu | vvvvvvvv | wwwwwwww | xxxxxxxx |

## 6. 代码

行内 `const x = 1` 与围栏代码块：

```ts
export function renderMarkdown(source: string): string {
  return md.render(source)
}
```

```python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

无语言标注的代码块：

```
plain text block
  with  indentation preserved
```

冷门语言（不在预加载的 24 种里，用于验证按需动态加载）：

```lua
local function greet(name)
  return "hello, " .. name
end

print(greet("world"))
```

```elixir
defmodule Demo do
  def greet(name), do: "hello, #{name}"
end
```

很长的单行代码（应横向滚动，不换行）：

```text
这是一行非常长的代码，用来验证 pre 元素的横向滚动行为而不会把整页撑宽，abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ 中文也可以一并测试。
```

## 7. 引用

> 这是引用段落。
>
> 引用里也能有**加粗**和 `代码`。

引用嵌套：

> 外层
>
> > 内层

## 8. 链接

[显式链接](https://tauri.app)、裸链接 https://vite.dev 应当自动成链、邮箱 test@example.com 同样。

## 9. 图片

相对路径图片（同目录下应存在 `sample-image.svg`）：

![样例图片](sample-image.svg)

## 10. 分隔线

上方内容

---

下方内容

## 11. 裸 HTML：白名单之内与之外

v0.2 起 markdown-it 放通了裸 HTML，渲染结果再过一遍 DOMPurify 白名单。规则是**能表达结构，不能执行代码**。这一节逐条验证。

### 应该生效的（白名单之内）

<details>
<summary>点我展开 —— 这个折叠块应当可以正常开合</summary>

折叠内容。`<details>` 是这轮放开 HTML 的主要动因，GFM 语法里没有对应的写法。

</details>

行内排版标签：按 <kbd>Ctrl</kbd>+<kbd>D</kbd> 切换大纲；水的化学式是 H<sub>2</sub>O；质能方程 E=mc<sup>2</sup>；<abbr title="Graphics Interchange Format">GIF</abbr> 是一种图像格式；这段是被 <mark>标记</mark> 的文字；<ins>插入</ins> 与 <del>删除</del>。

<div style="padding: 10px 14px; border-left: 3px solid #4a90d9; background: rgba(74,144,217,.08);">
这个 div 带内联 style，应当看到左边框与浅蓝底色 —— 内联样式是刻意放行的。
</div>

带 class 的标签同样保留：<span class="raw">class 属性在白名单里</span>。

内嵌媒体标签也在白名单内：<img src="./images/placeholder.png" alt="占位图" width="120"> —— 这个路径不存在，应当显示「加载失败」的占位，而不是浏览器的破图图标。

HTML 表格的 colspan / rowspan 属性在白名单里，应当正常跨列跨行：

<table>
  <thead>
    <tr><th colspan="2">跨两列的表头</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2">跨两行的单元格</td><td>右上一</td></tr>
    <tr><td>右下二</td></tr>
  </tbody>
</table>

### 应该被拦下的（白名单之外）

下面这行是裸 `<script>`。**不应弹窗**：整个标签连同内容一起消失，什么都不显示 —— DOMPurify 对 script 这类「内容本就不可见」的元素是连内容一起丢弃的。

<script>alert('不应该弹窗')</script>

下面是个 `<style>` 元素。同样整个消失，什么都不显示。内联 style 属性允许，但 `<style>` 元素不允许（它能 @import 外部样式、能做视觉劫持）。

<style>
  body { display: none !important; }
</style>

下面是个 `<iframe>`，应当被整个剥掉，什么都不显示，也不发起任何网络请求：

<iframe src="https://example.com/embed" width="400" height="300"></iframe>

表单控件一律不在白名单里。下面应当只剩可见的文本，没有输入框和按钮：

<form action="https://example.com/submit">
  <input type="text" name="field" value="不应出现输入框">
  <button type="submit">不应出现按钮</button>
</form>

内联 SVG 本轮**尚未放通**（批次 2 做 Mermaid 时才开），下面应只留下文字：

<svg width="100" height="40"><rect width="100" height="40" fill="#4a90d9"/><text x="8" y="25" fill="#fff">SVG 里这行字会留下</text></svg>

事件属性无条件剥离。下面是个带 onclick 的 div，**点击不应有任何反应**：

<div onclick="alert('事件属性应当被剥离')">点我试试 —— 这个 div 会显示，但 onclick 已被移除，点了没反应。</div>

## 12. 中文排版

中文段落里混排 English words 与 123 数字，验证字体回退与断行。中文标点，。！？；：""''（）——不应被 typographer 改写。

一段很长的中文用来观察行高与段间距：Markdown 阅读器的目标是让长文档在屏幕上读起来不累，所以行高、段间距、正文宽度都需要仔细调过，而不是直接套用浏览器的默认样式。当前正文宽度限制在 860 像素，行高 1.75，字号 16 像素。
