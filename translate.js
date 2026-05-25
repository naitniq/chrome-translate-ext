// 共享给 content script 与 options 页面：流式调用 LLM 翻译。
// 通过 globalThis.LLMTranslate 暴露 API。

(function (root) {
  "use strict";

  const DEFAULTS = {
    protocol: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    systemPrompt:
      "你是一个专业的翻译助手。请将用户提供的文本翻译为中文。仅输出译文，不要解释。如果原文已是中文，则翻译为英文。",
    maxTokens: 4096,
    temperature: "",
    extraBodyJson: ""
  };

  const STORAGE_KEY = "translateConfig";

  async function loadConfig() {
    const obj = await chrome.storage.sync.get(STORAGE_KEY);
    return { ...DEFAULTS, ...(obj[STORAGE_KEY] || {}) };
  }

  async function saveConfig(cfg) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
  }

  function validateConfig(cfg) {
    const missing = [];
    if (!cfg.baseUrl) missing.push("Base URL");
    if (!cfg.apiKey) missing.push("API Key");
    if (!cfg.model) missing.push("模型名");
    if (cfg.protocol !== "openai" && cfg.protocol !== "anthropic") {
      missing.push("协议");
    }
    return missing;
  }

  function parseExtraBody(jsonStr) {
    if (!jsonStr || !jsonStr.trim()) return {};
    return JSON.parse(jsonStr);
  }

  function joinUrl(base, path) {
    return base.replace(/\/+$/, "") + path;
  }

  // 把 fetch 响应体按 SSE 事件块切分（以 \n\n 分隔），逐块回调 onBlock(block)。
  async function readSseStream(resp, onBlock, signal) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        if (signal && signal.aborted) {
          try { await reader.cancel(); } catch (_) {}
          throw new DOMException("Aborted", "AbortError");
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.trim()) onBlock(block);
        }
      }
      if (buf.trim()) onBlock(buf);
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  // 解析单个 SSE 块为 { event, dataLines: string[] }
  function parseSseBlock(block) {
    let event = "";
    const dataLines = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return { event, data: dataLines.join("\n") };
  }

  // OpenAI 兼容流式
  async function streamOpenAI(text, cfg, onChunk, signal) {
    const url = joinUrl(cfg.baseUrl, "/chat/completions");
    const body = {
      model: cfg.model,
      stream: true,
      messages: [
        { role: "system", content: cfg.systemPrompt || DEFAULTS.systemPrompt },
        { role: "user", content: text }
      ],
      ...parseExtraBody(cfg.extraBodyJson)
    };
    if (cfg.temperature !== "" && cfg.temperature != null) {
      const t = Number(cfg.temperature);
      if (!Number.isNaN(t)) body.temperature = t;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }

    let any = false;
    await readSseStream(
      resp,
      (block) => {
        const { data } = parseSseBlock(block);
        if (!data) return;
        if (data === "[DONE]") return;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch (_) {
          return;
        }
        const choice = payload.choices && payload.choices[0];
        if (!choice) return;
        const delta = choice.delta || choice.message;
        const piece = delta && delta.content;
        if (typeof piece === "string" && piece.length) {
          any = true;
          onChunk(piece);
        }
      },
      signal
    );

    // 兜底：极少数兼容实现不支持 stream，则降级一次性请求
    if (!any) {
      const resp2 = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({ ...body, stream: false }),
        signal
      });
      if (!resp2.ok) {
        const errText = await resp2.text().catch(() => "");
        throw new Error(`HTTP ${resp2.status}: ${errText.slice(0, 500)}`);
      }
      const data = await resp2.json();
      const piece = data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content;
      if (typeof piece === "string" && piece.length) onChunk(piece);
    }
  }

  // Anthropic 原生流式
  async function streamAnthropic(text, cfg, onChunk, signal) {
    const url = joinUrl(cfg.baseUrl, "/v1/messages");
    const body = {
      model: cfg.model,
      max_tokens: Number(cfg.maxTokens) || DEFAULTS.maxTokens,
      stream: true,
      messages: [{ role: "user", content: text }]
    };
    if (cfg.systemPrompt) body.system = cfg.systemPrompt;
    if (cfg.temperature !== "" && cfg.temperature != null) {
      const t = Number(cfg.temperature);
      if (!Number.isNaN(t)) body.temperature = t;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body),
      signal
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }

    await readSseStream(
      resp,
      (block) => {
        const { event, data } = parseSseBlock(block);
        if (!data) return;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch (_) {
          return;
        }
        const evType = event || payload.type || "";
        if (evType === "content_block_delta") {
          const delta = payload.delta || {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            onChunk(delta.text);
          }
        }
      },
      signal
    );
  }

  async function streamTranslate(text, cfg, onChunk, signal) {
    if (cfg.protocol === "anthropic") {
      return streamAnthropic(text, cfg, onChunk, signal);
    }
    return streamOpenAI(text, cfg, onChunk, signal);
  }

  root.LLMTranslate = {
    DEFAULTS,
    STORAGE_KEY,
    loadConfig,
    saveConfig,
    validateConfig,
    streamTranslate
  };
})(globalThis);
