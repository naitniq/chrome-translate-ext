"use strict";

// 仅在顶层 frame 显示浮层
if (window.top === window) {
  initContentScript();
}

function initContentScript() {
  const HOST_ID = "llm-translate-host";
  let host = null;
  let shadow = null;
  let panel = null;
  let bodyEl = null;
  let statusEl = null;
  let titleEl = null;
  let copyBtn = null;
  let closeBtn = null;
  let abortCtrl = null;
  let lastResult = "";
  let userMoved = false;

  function buildPanel() {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          left: 0;
          top: 0;
          min-width: 280px;
          max-width: 460px;
          max-height: 60vh;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          color: #1f2328;
          border: 1px solid #d0d7de;
          border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
          font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI",
            "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
          pointer-events: auto;
          z-index: 2147483647;
          overflow: hidden;
        }
        .panel.hidden { display: none; }
        .head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          background: #f6f8fa;
          border-bottom: 1px solid #e3e5e8;
          user-select: none;
          cursor: grab;
        }
        .head.dragging { cursor: grabbing; }
        .panel.dragging { user-select: none; }
        .title {
          flex: 1;
          font-size: 12px;
          color: #57606a;
          font-weight: 600;
          letter-spacing: 0.2px;
        }
        .icon-btn {
          appearance: none;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 5px;
          padding: 3px 7px;
          font: inherit;
          font-size: 12px;
          color: #57606a;
          cursor: pointer;
        }
        .icon-btn:hover { background: #eef0f3; color: #1f2328; }
        .body {
          padding: 10px 12px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .body.empty::before {
          content: attr(data-placeholder);
          color: #8b949e;
          font-style: italic;
        }
        .status {
          padding: 6px 12px 10px;
          font-size: 12px;
          color: #6e7781;
          border-top: 1px dashed #e3e5e8;
        }
        .status.err { color: #cf222e; }
        .status:empty { display: none; }
        a.link {
          color: #0969da;
          cursor: pointer;
          text-decoration: underline;
        }
      </style>
      <div class="panel hidden" part="panel">
        <div class="head">
          <span class="title">LLM Translate</span>
          <button class="icon-btn" data-act="copy" title="复制">复制</button>
          <button class="icon-btn" data-act="close" title="关闭 (Esc)">×</button>
        </div>
        <div class="body" data-placeholder="正在请求…"></div>
        <div class="status"></div>
      </div>
    `;

    panel = shadow.querySelector(".panel");
    titleEl = shadow.querySelector(".title");
    bodyEl = shadow.querySelector(".body");
    statusEl = shadow.querySelector(".status");
    copyBtn = shadow.querySelector('[data-act="copy"]');
    closeBtn = shadow.querySelector('[data-act="close"]');
    const headEl = shadow.querySelector(".head");

    setupDrag(headEl);

    closeBtn.addEventListener("click", hide);
    copyBtn.addEventListener("click", () => {
      if (!lastResult) return;
      navigator.clipboard.writeText(lastResult).then(
        () => setStatus("已复制 ✓", false),
        () => setStatus("复制失败", true)
      );
    });

    // 阻止浮层内点击导致选区丢失或冒泡
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    // 全局 Esc 关闭
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.classList.contains("hidden")) hide();
    });

    // 点击页面其它区域关闭
    document.addEventListener(
      "mousedown",
      (e) => {
        if (panel.classList.contains("hidden")) return;
        if (e.target === host) return;
        if (host.contains(e.target)) return;
        hide();
      },
      true
    );
  }

  // 拖拽：按下标题栏后跟随鼠标移动浮层
  function setupDrag(headEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    headEl.addEventListener("mousedown", (e) => {
      // 点到标题栏上的按钮时不触发拖拽
      if (e.target && e.target.closest && e.target.closest(".icon-btn")) return;
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      headEl.classList.add("dragging");
      panel.classList.add("dragging");
      e.preventDefault();
      e.stopPropagation();
    });

    // 监听 window 而不是 document：拖到选区外也不丢事件
    window.addEventListener(
      "mousemove",
      (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const pw = panel.offsetWidth;
        const ph = panel.offsetHeight;
        // 至少留 24px 在视口内，避免完全拖出屏幕
        const left = Math.max(24 - pw, Math.min(vw - 24, originLeft + dx));
        const top = Math.max(0, Math.min(vh - 24, originTop + dy));
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        userMoved = true;
        e.preventDefault();
      },
      true
    );

    window.addEventListener(
      "mouseup",
      () => {
        if (!dragging) return;
        dragging = false;
        headEl.classList.remove("dragging");
        panel.classList.remove("dragging");
      },
      true
    );
  }

  function ensurePanel() {
    if (!panel) buildPanel();
  }

  function show() {
    ensurePanel();
    panel.classList.remove("hidden");
  }

  function hide() {
    if (!panel) return;
    panel.classList.add("hidden");
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch (_) {}
      abortCtrl = null;
    }
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (isError ? " err" : "");
  }

  function setBody(text) {
    bodyEl.textContent = text;
    bodyEl.classList.toggle("empty", !text);
    bodyEl.removeAttribute("data-placeholder");
  }

  function setBodyPlaceholder(placeholder) {
    bodyEl.textContent = "";
    bodyEl.setAttribute("data-placeholder", placeholder);
    bodyEl.classList.add("empty");
  }

  function appendBody(chunk) {
    if (bodyEl.classList.contains("empty")) {
      bodyEl.classList.remove("empty");
      bodyEl.removeAttribute("data-placeholder");
      bodyEl.textContent = "";
    }
    bodyEl.textContent += chunk;
    // 自动滚动到底部
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // 根据当前选区或页面中心定位浮层
  function positionPanel() {
    // 用户已手动拖拽过：尊重用户位置，仅校正越界
    if (userMoved) {
      panel.classList.remove("hidden");
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const rect = panel.getBoundingClientRect();
      const left = Math.max(24 - rect.width, Math.min(vw - 24, rect.left));
      const top = Math.max(0, Math.min(vh - 24, rect.top));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      // 用户拖拽后，按当前 top 限制最大高度
      panel.style.maxHeight = Math.max(120, vh - top - 8) + "px";
      return;
    }

    const sel = window.getSelection();
    let rect = null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) rect = r;
    }

    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // 先暂定一个高度上限再呈现以拿到宽度
    panel.style.maxHeight = Math.floor(vh * 0.6) + "px";
    panel.style.left = "-9999px";
    panel.style.top = "-9999px";
    panel.classList.remove("hidden");
    const pw = panel.offsetWidth;

    let left, top, maxH;
    if (rect) {
      left = Math.min(Math.max(8, rect.left), vw - pw - 8);
      const spaceBelow = vh - rect.bottom - 16;
      const spaceAbove = rect.top - 16;
      // 选区下方空间够 200px 就放下面，否则放上面
      if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
        top = rect.bottom + 8;
        maxH = Math.max(160, spaceBelow);
      } else {
        maxH = Math.max(160, spaceAbove);
        top = Math.max(8, rect.top - 8 - maxH);
      }
    } else {
      left = Math.max(8, (vw - pw) / 2);
      top = Math.max(8, vh * 0.15);
      maxH = vh - top - 16;
    }
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.maxHeight = Math.min(Math.floor(vh * 0.8), maxH) + "px";
  }

  async function handleTranslate(text) {
    text = (text || "").trim();
    ensurePanel();
    userMoved = false;
    show();
    titleEl.textContent = "LLM Translate";
    setStatus("");
    lastResult = "";

    if (!text) {
      setBodyPlaceholder("请先选中要翻译的文本");
      positionPanel();
      return;
    }

    // 取消上一次进行中的请求
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch (_) {}
    }
    abortCtrl = new AbortController();
    const mySignal = abortCtrl.signal;

    let cfg;
    try {
      cfg = await LLMTranslate.loadConfig();
    } catch (err) {
      setBodyPlaceholder("");
      setStatus("读取配置失败：" + err.message, true);
      positionPanel();
      return;
    }

    const missing = LLMTranslate.validateConfig(cfg);
    if (missing.length) {
      bodyEl.textContent = "";
      bodyEl.classList.remove("empty");
      const span = document.createElement("span");
      span.textContent = "请先在选项页配置：" + missing.join("、") + "。";
      const a = document.createElement("a");
      a.className = "link";
      a.textContent = " 打开设置";
      a.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      });
      bodyEl.appendChild(span);
      bodyEl.appendChild(a);
      positionPanel();
      return;
    }

    titleEl.textContent = `LLM Translate · ${cfg.model}`;
    setBodyPlaceholder("正在请求…");
    positionPanel();

    try {
      await LLMTranslate.streamTranslate(
        text,
        cfg,
        (chunk) => {
          if (mySignal.aborted) return;
          lastResult += chunk;
          appendBody(chunk);
        },
        mySignal
      );
      if (!mySignal.aborted) {
        if (!lastResult) {
          setStatus("模型未返回任何内容", true);
        } else {
          setStatus("完成 ✓", false);
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      setStatus("出错：" + (err && err.message ? err.message : String(err)), true);
    } finally {
      if (abortCtrl && abortCtrl.signal === mySignal) abortCtrl = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "TRANSLATE") {
      // 优先从页面真实选区取文本：info.selectionText 会把段落间 \n\n 折叠成单 \n
      // 甚至空格，丢失原文结构。getSelection().toString() 保留换行更准确。
      let text = "";
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          text = sel.toString();
        }
      } catch (_) {}
      if (!text || !text.trim()) text = msg.text || "";
      handleTranslate(text);
      sendResponse({ ok: true });
    }
    return false;
  });
}
