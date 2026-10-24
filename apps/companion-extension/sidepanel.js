const $ = (selector) => document.querySelector(selector);
const connection = $("#connection");
const tabTitle = $("#tab-title");
const adoptSpace = $("#adopt-space");
const adopt = $("#adopt");
const spacesContainer = $("#spaces");
const empty = $("#empty");
const template = $("#space-template");
const picker = $("#context-picker");
const sourceList = $("#source-list");
const search = $("#source-search");
const attachmentsElement = $("#attachments");
const prompt = $("#prompt");
const status = $("#compose-status");
const messages = $("#messages");
const attachments = new Map();
let chatState = { tabs: [], groups: [], collections: [] };
let source = "tabs";

$("#refresh").addEventListener("click", refreshAll);
$("#add-context").addEventListener("click", () => { picker.hidden = !picker.hidden; if (!picker.hidden) void renderSources(); });
$("#close-picker").addEventListener("click", () => { picker.hidden = true; });
$("#copy-context").addEventListener("click", copyContext);
$("#send").addEventListener("click", sendMessage);
search.addEventListener("input", renderSources);
for (const button of document.querySelectorAll(".view-tab")) {
  button.addEventListener("click", () => switchView(button.dataset.view));
}
for (const button of document.querySelectorAll(".source-tab")) {
  button.addEventListener("click", () => {
    source = button.dataset.source;
    document.querySelectorAll(".source-tab").forEach((item) => item.classList.toggle("active", item === button));
    void renderSources();
  });
}
adopt.addEventListener("click", async () => {
  await command("ui.adoptCurrentTab", adoptSpace.value);
  await refreshAll();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.method === "ui.changed") void refreshAll();
});

await refreshAll();

async function refreshAll() {
  await Promise.all([renderTasks(), loadChatState()]);
}

async function renderTasks() {
  const state = await chrome.runtime.sendMessage({ method: "ui.state" });
  connection.textContent = state.error || !state.connected ? "未连接" : "本地连接";
  tabTitle.textContent = state.currentTab?.title || "无可用标签";
  adoptSpace.replaceChildren();
  spacesContainer.replaceChildren();
  for (const space of state.spaces || []) {
    const option = document.createElement("option");
    option.value = space.taskId;
    option.textContent = space.name;
    adoptSpace.append(option);
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".space-name").textContent = space.name;
    const ownership = fragment.querySelector(".ownership");
    const userControl = space.ownership !== "agent";
    ownership.textContent = userControl ? "用户控制" : "Agent 控制";
    ownership.classList.toggle("user", userControl);
    fragment.querySelector(".meta").textContent = `${space.tabCount} 个标签 · ${space.lifecycle || "active"}`;
    const takeControl = fragment.querySelector(".take-control");
    takeControl.disabled = space.ownership !== "agent";
    takeControl.addEventListener("click", () => command("ui.takeControl", space.taskId));
    const authorize = fragment.querySelector(".authorize");
    authorize.disabled = space.ownership !== "agentDelegatedToUser";
    authorize.addEventListener("click", () => command("ui.authorizeTakeover", space.taskId));
    spacesContainer.append(fragment);
  }
  empty.hidden = Boolean(state.spaces?.length);
  adopt.disabled = !state.connected || !state.currentTab || !state.spaces?.length;
}

async function loadChatState() {
  const result = await chrome.runtime.sendMessage({ method: "ui.chatState", query: source === "collections" ? search.value : "" });
  if (result?.error) {
    status.textContent = result.error;
    return;
  }
  chatState = result;
  status.textContent = `${chatState.tabs.length} 个可用标签`;
  if (!picker.hidden) await renderSources();
}

async function renderSources() {
  if (source === "collections") {
    const result = await chrome.runtime.sendMessage({ method: "ui.chatState", query: search.value });
    if (!result?.error) chatState.collections = result.collections;
  }
  sourceList.replaceChildren();
  const needle = search.value.trim().toLowerCase();
  if (source === "collections") {
    for (const item of chatState.collections || []) {
      if (!matches(item.text, item.pageTitle, item.sourceUrl, needle)) continue;
      sourceList.append(sourceRow({
        id: `collection-${item.id}`,
        title: item.text,
        subtitle: item.pageTitle || item.sourceUrl || "收藏",
        onSelect: () => addCollection(item),
      }));
    }
    return;
  }
  for (const group of chatState.groups || []) {
    if (matches(group.title, "", "", needle)) {
      sourceList.append(sourceRow({
        id: `group-${group.id}`,
        title: group.title,
        subtitle: `${group.tabs.length} 个标签`,
        onSelect: () => addGroup(group),
      }));
    }
  }
  for (const tab of chatState.tabs || []) {
    if (!matches(tab.title, tab.url, "", needle)) continue;
    sourceList.append(sourceRow({
      id: `tab-${tab.id}`,
      title: tab.title || tab.url,
      subtitle: tab.url,
      onSelect: () => addTab(tab),
    }));
  }
}

function sourceRow({ id, title, subtitle, onSelect }) {
  const label = document.createElement("label");
  label.className = "source-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = attachments.has(id);
  checkbox.addEventListener("change", () => checkbox.checked ? onSelect() : removeAttachment(id));
  const copy = document.createElement("div");
  copy.className = "source-copy";
  const titleElement = document.createElement("div");
  titleElement.className = "source-title";
  titleElement.textContent = title;
  const url = document.createElement("div");
  url.className = "source-url";
  url.textContent = subtitle;
  copy.append(titleElement, url);
  label.append(checkbox, copy);
  return label;
}

async function addTab(tab) {
  picker.hidden = true;
  const id = `tab-${tab.id}`;
  setAttachment({ id, type: "tab", title: tab.title || tab.url, state: "loading" });
  const page = await chrome.runtime.sendMessage({ method: "ui.chatPageContent", targetId: tab.id });
  const content = page?.rootNode ? treeToMarkdown(page.rootNode) : "";
  setAttachment({
    id,
    type: "tab",
    title: page?.title || tab.title || tab.url,
    sourceUrl: tab.url,
    domain: domainOf(tab.url),
    favicon: tab.faviconUrl || "",
    content,
    state: content ? "success" : "error",
  });
}

async function addGroup(group) {
  picker.hidden = true;
  const id = `group-${group.id}`;
  setAttachment({ id, type: "group", title: group.title, state: "loading" });
  const pages = await Promise.all(group.tabs.map(async (tab) => {
    const page = await chrome.runtime.sendMessage({ method: "ui.chatPageContent", targetId: tab.id });
    const content = page?.rootNode ? treeToMarkdown(page.rootNode) : "";
    return content ? wrapContext(tab, content) : null;
  }));
  const contexts = pages.filter(Boolean);
  setAttachment({
    id,
    type: "group",
    title: group.title,
    state: contexts.length ? "success" : "error",
    content: contexts.length
      ? `<context-group title="${escapeAttribute(group.title)}" color="${escapeAttribute(group.color || "")}" count="${group.tabs.length}">\n${contexts.join("\n")}\n</context-group>`
      : "",
  });
}

function addCollection(item) {
  picker.hidden = true;
  setAttachment({
    id: `collection-${item.id}`,
    type: "collection",
    title: item.pageTitle || item.text.slice(0, 48),
    state: "success",
    content: `<context type="selected-text" source="${escapeAttribute(item.sourceUrl || "")}" title="${escapeAttribute(item.pageTitle || "")}">\n${item.text}\n</context>`,
  });
}

function setAttachment(value) {
  attachments.set(value.id, value);
  renderAttachments();
}

function removeAttachment(id) {
  attachments.delete(id);
  renderAttachments();
  if (!picker.hidden) void renderSources();
}

function renderAttachments() {
  attachmentsElement.replaceChildren();
  for (const item of attachments.values()) {
    const chip = document.createElement("div");
    chip.className = `attachment ${item.state}`;
    const label = document.createElement("span");
    label.textContent = item.state === "loading" ? `正在读取 ${item.title}` : item.title;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "移除";
    remove.setAttribute("aria-label", "移除");
    remove.textContent = "×";
    remove.addEventListener("click", () => removeAttachment(item.id));
    chip.append(label, remove);
    attachmentsElement.append(chip);
  }
}

async function sendMessage() {
  const text = prompt.value.trim();
  const context = buildContext();
  if (!text && !context) return;
  addMessage(text || "使用所选上下文", "user", `${attachments.size} 个上下文`);
  const pending = addMessage("正在思考…", "assistant", "");
  prompt.value = "";
  status.textContent = "正在生成回答";
  $("#send").disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      method: "ui.chatSend",
      prompt: text || "请基于所选上下文进行总结。",
      context,
    });
    if (response?.error) throw new Error(response.error);
    pending.firstChild.textContent = response.text;
    pending.querySelector(".message-meta").textContent = [response.model, ...(response.activities || [])].filter(Boolean).join(" · ");
    status.textContent = "回答完成";
  } catch (error) {
    pending.firstChild.textContent = error instanceof Error ? error.message : String(error);
    pending.classList.add("error");
    status.textContent = "生成失败";
  } finally {
    $("#send").disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
}

async function copyContext() {
  const content = buildContext();
  if (!content) return void (status.textContent = "没有可复制的上下文");
  await navigator.clipboard.writeText(content);
  status.textContent = "上下文已复制";
}

function buildContext() {
  return [...attachments.values()].filter((item) => item.state === "success" && item.content).map((item) => {
    if (item.type !== "tab") return item.content;
    return `<context source="${escapeAttribute(item.sourceUrl || "")}" title="${escapeAttribute(item.title)}" domain="${escapeAttribute(item.domain || "")}" favicon="${escapeAttribute(item.favicon || "")}">\n${item.content}\n</context>`;
  }).join("\n");
}

function addMessage(text, kind, meta) {
  const message = document.createElement("div");
  message.className = `message ${kind}`;
  const body = document.createElement("div");
  body.textContent = text;
  const details = document.createElement("div");
  details.className = "message-meta";
  details.textContent = meta;
  message.append(body, details);
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
  return message;
}

function treeToMarkdown(root) {
  const output = [];
  const skipped = new Set([1, 8, 9, 10, 11, 12]);
  const text = (node) => node.textInfo?.textContent || (node.children || []).map(text).filter(Boolean).join(" ");
  const visit = (node) => {
    if (skipped.has(node.attributeType)) return;
    const value = text(node);
    if (node.attributeType === 6) { if (value) output.push(`\n## ${value}\n`); return; }
    if (node.attributeType === 4) { if (value) output.push(node.label ? `[${value}](${node.label})` : value); return; }
    if (node.attributeType === 7) { if (node.label) output.push(`[Image: ${node.label}]`); return; }
    if (node.attributeType === 18) { if (value) output.push(`- ${value}`); return; }
    if (node.attributeType === 5) { if (value) output.push(`\n${value}\n`); return; }
    if (node.attributeType === 14) { const cells = (node.children || []).map(text).filter(Boolean); if (cells.length) output.push(cells.join(" | ")); return; }
    if (node.textInfo?.textContent) output.push(node.textInfo.textContent);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function wrapContext(tab, content) {
  return `<context source="${escapeAttribute(tab.url)}" title="${escapeAttribute(tab.title)}" domain="${escapeAttribute(domainOf(tab.url))}" favicon="${escapeAttribute(tab.faviconUrl || "")}">\n${content}\n</context>`;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function matches(a, b, c, needle) { return !needle || `${a || ""} ${b || ""} ${c || ""}`.toLowerCase().includes(needle); }

function switchView(view) {
  document.querySelectorAll(".view-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`));
}

async function command(method, taskId) {
  const result = await chrome.runtime.sendMessage({ method, taskId });
  connection.textContent = result?.error || "已更新";
}
