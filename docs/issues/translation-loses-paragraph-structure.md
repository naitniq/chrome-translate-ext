# 翻译丢失原文段落结构

## 背景

LLM Translate 扩展在网页上选中跨多段的文本（段落之间有空行）后右键触发翻译，浮层流式展示译文。

触发条件：

- 选区跨越两个或多个段落（HTML 上是相邻 `<p>` 或包含 `\n\n` 的纯文本块）。
- 原文中段与段之间存在空行作为视觉分隔。

## 现象

原文：

```
If you're not sure where to start, use gpt-5.5, our flagship model for complex
reasoning and coding. If you're optimizing for latency and cost, choose a smaller
variant like gpt-5.4-mini or gpt-5.4-nano.

All latest OpenAI models support text and image input, text output, multilingual
capabilities, and vision. Models are available via the Responses API and our
Client SDKs.
```

翻译结果（两段被合并为一段，段间空行丢失）：

```
如果你不确定从哪里开始，可以使用 GPT-5.5……GPT-5.4-mini 或 GPT-5.4-nano。所有
最新的 OpenAI 模型均支持文本和图像输入、文本输出、多语言功能以及视觉能力……
```

## 根因分析

两个独立但叠加的问题：

1. **取文链路丢结构**：`background.js` 用 `chrome.contextMenus.onClicked` 的 `info.selectionText` 作为待翻译文本传给 content script。`info.selectionText` 会把跨段落选择中的空行（`\n\n`）折叠成单 `\n`，甚至在某些 DOM 结构下折叠成空格，原文段落分隔在到达模型之前就已经丢失。
2. **prompt 未约束保留结构**：默认 system prompt 仅要求"仅输出译文，不要解释"，未告知模型保留换行/空行。即便偶然带着 `\n\n` 进去，模型也容易在追求自然中文译文时把多段合成一大段输出。

渲染端 `.body` 的 CSS `white-space: pre-wrap` 本身可以正确显示 `\n` / `\n\n`，所以渲染层没有问题。

## 解决方案

`content.js` + `translate.js` 各改一处：

1. **content.js 改用真实选区文本**：在 `chrome.runtime.onMessage` 监听 TRANSLATE 时，优先 `window.getSelection().toString()` 取页面 DOM 真实选区，它能保留段落间 `\n\n`；选区为空（少数极端 case）时再回退到 `msg.text`。注意 `handleTranslate` 内部的 `text.trim()` 只去除首尾空白，保留中间的换行结构。
2. **translate.js 更新默认 system prompt**：增加明确指令"严格保留原文段落结构与换行；原文中的空行必须以同样空行保留；不要合并段落"。同时保留"仅输出译文，不要解释"。

### 已知遗留

`DEFAULTS.systemPrompt` 改动只影响**首次安装**或**未保存过 prompt 的用户**。已在选项页保存过自定义 prompt 的用户不会被自动覆盖，需要手动在自己的 prompt 里追加同样的"保留段落"指令。可后续考虑：

- 在选项页加一行帮助文字，建议用户把保留段落规则纳入自定义 prompt。
- 或在请求拼装时无条件追加一条 reinforcement 指令（成本：略微污染用户自定义 prompt 意图）。

## 相关文件

- `background.js`：仍用 `info.selectionText` 作为兜底（content script 取不到选区时使用），未改。
- `content.js`：`chrome.runtime.onMessage` 监听内新增 `window.getSelection().toString()` 优先取文。
- `translate.js`：`DEFAULTS.systemPrompt` 改写，要求保留段落结构。
- `content.js` 渲染：`.body` 的 `white-space: pre-wrap` 不变。
