# LLM Translate · Chrome 扩展

一个基于 Manifest V3 的 Chrome 扩展：在网页上选中文本后右键，菜单中出现"翻译此段（LLM Translate）"选项；点击后调用用户自配的 LLM 进行翻译，并以**浮层流式**形式在选区附近展示结果。

模型协议设计——支持两种主流协议，所有连接信息完全自定义，不内置任何 provider/网关地址。

## 功能特性

- **右键菜单触发**：仅在有文本选区时显示菜单项，零侵入。
- **流式输出**：使用 fetch + SSE 增量渲染，像打字机一样实时显示译文。
- **双协议支持**：
  - OpenAI 兼容（`POST {baseUrl}/chat/completions`，`Authorization: Bearer …`）
  - Anthropic 原生（`POST {baseUrl}/v1/messages`，`x-api-key` + `anthropic-version`）
- **浮层 UI**：选区附近气泡，Shadow DOM 隔离样式，Esc / 外部点击 / 关闭按钮均可收起；中途取消会同步 abort 请求。
- **完全自定义配置**：协议、Base URL、API Key、模型名、System Prompt、`max_tokens`、`temperature`、`extra_body` 全部由用户填写，不预置任何网关或密钥。
- **测试连接**：选项页内置一键自检，避免在网页上反复试错。

## 项目结构

```
chrome-translate-ext/
├── manifest.json          # MV3 清单
├── background.js          # 注册右键菜单 / 消息转发 / 打开设置
├── translate.js           # 共享：配置读写 + 双协议流式调用（content/options 共用）
├── content.js             # Shadow DOM 浮层 + 选区定位 + Esc/取消
├── content.css            # 仅 host 元素 z-index 兜底
├── options.html / .js / .css   # 设置页表单 + 测试连接
├── icons/                 # 16/48/128 占位图标
└── README.md
```

### 设计要点

- **请求发起放在 content script** 而非 service worker：MV3 service worker 30s 空闲会被回收，长流式响应会被截断。Content script 生命周期跟随页面，更稳定。
- **Shadow DOM 隔离**：浮层 DOM 与样式封装在 Shadow Root 内，避免被宿主页面 CSS 污染。
- **SSE 解析统一封装**：`translate.js` 内 `readSseStream` + `parseSseBlock` 处理通用切块逻辑，两种协议各自解析 payload。
- **OpenAI 流式回退**：极少数兼容网关不支持 `stream:true`，会自动降级为一次性请求兜底。
- **AbortController**：关闭浮层 / 重新触发 / Esc 都会立即 abort 进行中的请求。

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`。
2. 开启右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目目录（即包含 `manifest.json` 的目录）。
4. 在扩展列表中找到 **LLM Translate**，点击 **详情** → **扩展程序选项**（或直接点工具栏图标）进入设置。

## 配置

进入选项页（"扩展程序选项"或点击扩展图标）后填写：

| 字段 | 说明 | 备注 |
|------|------|------|
| 协议 | `OpenAI 兼容` 或 `Anthropic 原生` | 决定请求路径与鉴权头 |
| Base URL | LLM 网关根地址 | 填到根路径，**不要**带 `/chat/completions` 或 `/v1/messages` |
| API Key | 鉴权 Key | OpenAI 走 `Authorization: Bearer`，Anthropic 走 `x-api-key` |
| 模型名 | 例如 `gpt-4o`、`claude-sonnet-4-5-20250929` | 直接传给后端的 `model` 字段 |
| System Prompt | 翻译指令 | 默认为中英互译，仅输出译文 |
| max_tokens | 仅 Anthropic 协议生效 | 默认 4096 |
| temperature | 可选，留空则不传 | 0–2 |
| Extra Body | 可选 JSON | 仅 OpenAI 协议生效，会平铺到请求 body 顶层（对应 `Config.py` 的 `extra_body`） |

> Base URL 填法示例：
> - OpenAI 兼容（comate 网关）：`https://your-gateway.example.com/v1`
> - Anthropic 网关：`https://your-anthropic-gateway.example.com`（扩展会自动拼 `/v1/messages`）

填完点击 **保存**，可点 **测试连接** 用一段固定英文做一次完整流式调用确认连通性。

## 使用

1. 在任意网页（如英文 Wikipedia 文章）选中一段文本。
2. 右键 → 点击 **翻译此段（LLM Translate）**。
3. 选区附近会出现浮层并开始流式输出译文。
4. 操作：
   - 点击 **复制**：拷贝译文到剪贴板。
   - 点击 **×** / 按 **Esc** / 点击页面其它区域：关闭浮层，同步取消正在进行的请求。

## 协议示例

### OpenAI 兼容

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "...",
  "stream": true,
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "<选中文本>"}
  ],
  ...extraBody
}
```

SSE 取 `data:` 行的 `choices[0].delta.content`，遇 `data: [DONE]` 结束。

### Anthropic 原生

```http
POST {baseUrl}/v1/messages
x-api-key: {apiKey}
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "...",
  "max_tokens": 4096,
  "stream": true,
  "system": "...",
  "messages": [{"role": "user", "content": "<选中文本>"}]
}
```

SSE 仅在 `event: content_block_delta` + `data.delta.type === "text_delta"` 时取 `delta.text`（参考 `llm_interface.py:466-509`）。

## 故障排查

| 现象 | 原因与处理 |
|------|------|
| 右键菜单不出现 | 必须先**选中文本**菜单项才会显示；`chrome://`、`view-source:` 等特殊页面无法注入 content script。 |
| 浮层提示"请先在选项页配置" | 缺少 Base URL / API Key / 模型名，点击"打开设置"补齐。 |
| `HTTP 401/403` | API Key 错误或没有该模型权限。 |
| `HTTP 404` | Base URL 末尾误带了 `/chat/completions`；改为根路径。 |
| 流式没有输出 | 个别网关不支持 SSE，OpenAI 路径已自动回退一次性请求；Anthropic 路径请确认 base_url 正确并在网关支持 `/v1/messages`。 |
| 跨域失败 | 已申请 `host_permissions: <all_urls>`，正常情况下扩展可访问任意域名；若公司网关有 IP 白名单/SSO，需在浏览器层面确保可访问。 |

## 隐私

- 所有配置（含 API Key）通过 `chrome.storage.sync` 存储在用户本地的 Chrome 同步空间。
- 扩展不向任何第三方服务器上报使用数据；仅在用户主动触发翻译时向你配置的 Base URL 发送选中文本。

## 许可

MIT Licence
