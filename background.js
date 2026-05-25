const MENU_ID = "llm-translate-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "翻译此段（LLM Translate）",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab || tab.id == null) return;
  const text = (info.selectionText || "").trim();
  chrome.tabs.sendMessage(tab.id, { type: "TRANSLATE", text }).catch(() => {
    // content script 未加载时静默失败（如 chrome:// 页面）
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});
