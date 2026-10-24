// This function runs only in a dedicated isolated world in the guest page.
export function pageTranslation(command, payload = {}) {
  const key = "__egoPageTranslation";
  const excluded = 'script,style,noscript,textarea,input,select,option,pre,code,kbd,samp,svg,math,iframe,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[hidden],[aria-hidden="true"]';
  const eligible = node => node.isConnected && node.parentElement
    && !node.parentElement.closest(excluded) && !node.parentElement.isContentEditable;
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  let state = globalThis[key];
  if (command === "describe") return { language: document.documentElement.lang || "", supported: /^https?:$/.test(location.protocol) && document.contentType === "text/html" };
  if (command === "init") {
    if (!/^https?:$/.test(location.protocol) || document.contentType !== "text/html") {
      throw new Error("仅支持普通 HTTP 或 HTTPS 网页");
    }
    if (state) throw new Error("请先恢复原文");
    state = { token: payload.token, records: new Map(), next: 0, dirty: true, stopped: false };
    state.observer = new MutationObserver(() => { state.dirty = true; });
    state.observer.observe(document, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden", "translate", "contenteditable"] });
    state.scroll = () => { state.dirty = true; };
    window.addEventListener("scroll", state.scroll, { passive: true });
    globalThis[key] = state;
    return { language: document.documentElement.lang || "" };
  }
  if (!state || state.token !== payload.token) return { stale: true };
  if (command === "resume") {
    state.stopped = false;
    state.dirty = true;
    for (const record of state.records.values()) record.pending = false;
    state.observer.observe(document, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden", "translate", "contenteditable"] });
    window.addEventListener("scroll", state.scroll, { passive: true });
    return { resumed: true };
  }
  if (command === "stop" || command === "restore") {
    state.observer.disconnect();
    window.removeEventListener("scroll", state.scroll);
    state.stopped = true;
    if (command === "stop") return { stopped: true };
    let restored = 0;
    for (const [node, record] of state.records) {
      if (node.isConnected && record.translated !== undefined && node.nodeValue === record.translated) {
        node.nodeValue = record.original;
        restored++;
      }
    }
    state.records.clear();
    delete globalThis[key];
    return { restored };
  }
  if (state.stopped) return { stopped: true };
  if (command === "collect") {
    if (!state.dirty) return { blocks: [], pending: false };
    state.dirty = false;
    for (const [node] of state.records) if (!node.isConnected) state.records.delete(node);
    const groups = new Map();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    let chars = 0;
    let pending = false;
    const candidates = new Map();
    while ((node = walker.nextNode())) {
      if (!eligible(node) || !node.nodeValue.trim() || !/\p{L}/u.test(node.nodeValue)) continue;
      const old = state.records.get(node);
      if (old && (old.translated === node.nodeValue || (old.pending && old.original === node.nodeValue))) continue;
      if (node.nodeValue.length > 4000 || !node.parentElement.getClientRects().length) continue;
      const style = getComputedStyle(node.parentElement);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = node.parentElement.getBoundingClientRect();
      const parent = node.parentElement.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption") || node.parentElement;
      const priority = rect.bottom >= 0 && rect.top < innerHeight ? 0 : 1;
      const candidate = candidates.get(parent) || { nodes: [], priority };
      candidate.nodes.push(node);
      candidate.priority = Math.min(candidate.priority, priority);
      candidates.set(parent, candidate);
    }
    // Prioritize whole paragraphs without reordering their inline text.
    const ordered = [...candidates.values()].sort((a, b) => a.priority - b.priority);
    for (node of ordered.flatMap(candidate => candidate.nodes)) {
      if (chars + node.nodeValue.length > 8000) { pending = true; break; }
      const parent = node.parentElement.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption") || node.parentElement;
      if (!groups.has(parent) && groups.size >= 30) { pending = true; break; }
      const record = { id: ++state.next, original: node.nodeValue, pending: true };
      state.records.set(node, record);
      const group = groups.get(parent) || [];
      group.push(record);
      groups.set(parent, group);
      chars += node.nodeValue.length;
    }
    state.dirty = pending;
    return {
      blocks: [...groups.values()].map(records => ({
        ids: records.map(record => record.id),
        html: `<div>${records.map(record => `<span id="ego-t-${record.id}">${escape(record.original)}</span>`).join("")}</div>`,
      })),
      pending,
    };
  }
  if (command === "apply") {
    const values = new Map();
    // Parse inert HTML for text only; never attach translated markup to the page.
    for (const block of payload.blocks) {
      const template = document.createElement("template");
      template.innerHTML = block.html;
      const parsed = template.content;
      for (const id of block.ids) {
        const matches = parsed.querySelectorAll(`[id="ego-t-${id}"]`);
        if (matches.length !== 1) throw new Error("翻译服务返回的段落标记不完整，请恢复原文后重试");
        const value = matches[0].textContent;
        if (value.length > 20000) throw new Error("译文长度异常");
        values.set(id, value);
      }
    }
    let applied = 0;
    for (const [node, record] of state.records) {
      if (!values.has(record.id)) continue;
      record.pending = false;
      if (!eligible(node) || node.nodeValue !== record.original) { state.dirty = true; continue; }
      record.translated = values.get(record.id);
      node.nodeValue = record.translated;
      applied++;
    }
    return { applied };
  }
  throw new Error("Unknown translation command");
}

export function translationScript(command, payload) {
  return `(() => { try { return (${pageTranslation.toString()})(${JSON.stringify(command)},${JSON.stringify(payload)}); }
    catch (error) { return { translationError: String(error.message) }; } })()`;
}
