"use strict";

const FIELDS = [
  "protocol",
  "baseUrl",
  "apiKey",
  "model",
  "systemPrompt",
  "maxTokens",
  "temperature",
  "extraBodyJson"
];

const els = Object.fromEntries(FIELDS.map((k) => [k, document.getElementById(k)]));
const form = document.getElementById("form");
const statusEl = document.getElementById("status");
const testBtn = document.getElementById("test");
const testOutput = document.getElementById("testOutput");
const testOutputBody = document.getElementById("testOutputBody");

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function readForm() {
  const cfg = {};
  for (const k of FIELDS) {
    const el = els[k];
    if (!el) continue;
    cfg[k] = el.value;
  }
  return cfg;
}

function writeForm(cfg) {
  for (const k of FIELDS) {
    const el = els[k];
    if (!el) continue;
    const v = cfg[k];
    el.value = v == null ? "" : String(v);
  }
}

async function init() {
  const cfg = await LLMTranslate.loadConfig();
  writeForm(cfg);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cfg = readForm();
  // 校验 extraBodyJson 是合法 JSON
  if (cfg.extraBodyJson && cfg.extraBodyJson.trim()) {
    try {
      JSON.parse(cfg.extraBodyJson);
    } catch (err) {
      setStatus("Extra Body 不是合法 JSON：" + err.message, "err");
      return;
    }
  }
  await LLMTranslate.saveConfig(cfg);
  setStatus("已保存 ✓", "ok");
  setTimeout(() => setStatus(""), 2000);
});

testBtn.addEventListener("click", async () => {
  const cfg = readForm();
  const missing = LLMTranslate.validateConfig(cfg);
  if (missing.length) {
    setStatus("缺少字段：" + missing.join("、"), "err");
    return;
  }
  if (cfg.extraBodyJson && cfg.extraBodyJson.trim()) {
    try {
      JSON.parse(cfg.extraBodyJson);
    } catch (err) {
      setStatus("Extra Body 不是合法 JSON：" + err.message, "err");
      return;
    }
  }

  testBtn.disabled = true;
  setStatus("测试中…");
  testOutput.hidden = false;
  testOutputBody.textContent = "";

  const sample = "Hello, world. This is a quick connectivity test.";
  const ctrl = new AbortController();
  try {
    await LLMTranslate.streamTranslate(
      sample,
      cfg,
      (chunk) => {
        testOutputBody.textContent += chunk;
      },
      ctrl.signal
    );
    setStatus("测试完成 ✓", "ok");
  } catch (err) {
    setStatus("测试失败：" + err.message, "err");
    testOutputBody.textContent += "\n\n[ERROR] " + err.message;
  } finally {
    testBtn.disabled = false;
  }
});

init();
