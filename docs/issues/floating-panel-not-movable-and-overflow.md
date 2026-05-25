# 浮层不可移动且长译文超屏不可阅读

## 背景

LLM Translate 扩展在网页上选中文本后右键触发翻译，结果以浮层（Shadow DOM）显示在选区附近，并以流式方式逐字追加。

触发条件：

- 选区位于视口下半部分。
- 翻译结果较长（流式输出会让面板从占位符高度逐步增长到 `max-height`）。

## 现象

1. **浮层无法移动**：标题栏没有拖拽能力，浮层位置完全由 `positionPanel()` 一次性决定。
2. **长译文超屏不可阅读**：当选区靠近视口底部时，浮层向下展开后底部超出视口，超出部分既无法滚动看到（外层被 viewport 截断），也无法把面板拖到能看见的地方。

## 根因分析

`content.js` 内的 `positionPanel()`：

- 只在翻译开始时基于占位符高度（约 80px）计算 `top`。例如选区底部 `rect.bottom = 700`、视口高 `vh = 800`、占位符 `ph = 80`，判断 `700 + 80 + 8 ≤ 800` 成立，于是把面板放到 `top = 708`。
- 面板 CSS 设了 `max-height: 60vh`（≈480px），随着流式 chunk 追加，面板真实高度增长到 480px。最终 `top + height = 708 + 480 = 1188`，远超视口 800，底部 388px 不可见。
- 没有提供任何手动调整位置的入口（标题栏 `cursor: default`，无 `mousedown` 拖拽逻辑）。

本质上是两层问题：定位时未考虑后续内容增长 + 没有兜底的拖拽手段。

## 解决方案

`content.js` 内做了三处改动：

1. **拖拽**：新增 `setupDrag(headEl)`，标题栏 `cursor: grab`，按下后用 `window` 上的 `mousemove` / `mouseup`（`true` 捕获）跟随鼠标更新 `panel.style.left/top`，clamp 至少留 24px 在视口内。点击 `.icon-btn`（复制 / 关闭）时跳过拖拽，避免误触。设置 `userMoved = true` 标记。
2. **动态 max-height**：`positionPanel()` 改为先算选区下方/上方可用空间 `spaceBelow` / `spaceAbove`：
   - 下方 ≥ 200px 或下方 ≥ 上方 → 放下面，`max-height = spaceBelow`。
   - 否则翻到选区上方，`top = rect.top - 8 - maxH`，`max-height = spaceAbove`。
   - 面板 `.body` 已是 `overflow: auto`，超出部分可滚动阅读。
3. **尊重用户位置**：`userMoved` 为 true 时 `positionPanel()` 不重定位，仅校正越界并按当前 `top` 重设 `max-height`，避免流式更新覆盖用户拖到的位置。新一次翻译开始时（`handleTranslate` 入口）重置 `userMoved = false`，使面板回到选区附近。

## 相关文件

- `content.js`
  - `buildPanel()` 中 `.head` 样式：`cursor: grab` + `.dragging` 状态
  - 新增 `setupDrag(headEl)`
  - `positionPanel()` 重写
  - `handleTranslate()` 开头重置 `userMoved`
- `content.css`：未变更（仅托管 host 元素 z-index）
