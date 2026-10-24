export function bindTranslation({ invoke, currentTab, onError }) {
  const languages = {
    "zh-Hans": "中文（简体）", "zh-Hant": "中文（繁体）", en: "英语", ja: "日语",
    ko: "韩语", fr: "法语", de: "德语", es: "西班牙语", ru: "俄语", pt: "葡萄牙语",
  };
  const anchor = document.querySelector("#browser-translate");
  const panel = document.createElement("section");
  panel.id = "translation-panel";
  panel.className = "translation-panel";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "translation-heading");
  panel.innerHTML = `
    <header>
      <button type="button" class="translation-icon" data-back hidden title="返回翻译" aria-label="返回翻译"><i data-lucide="arrow-left"></i></button>
      <h2 id="translation-heading">翻译此页？</h2>
      <button type="button" class="translation-icon" data-close title="关闭" aria-label="关闭"><i data-lucide="x"></i></button>
    </header>
    <div data-main>
      <label class="translation-target">翻译为<select data-target aria-label="翻译为"></select></label>
      <p data-status role="status" aria-live="polite" hidden></p>
      <footer>
        <button type="button" data-translate class="translation-primary">翻译</button>
        <button type="button" data-more class="translation-secondary" aria-expanded="false" aria-controls="translation-more">更多<i data-lucide="chevron-down"></i></button>
      </footer>
      <div id="translation-more" data-more-menu hidden>
        <button type="button" data-restore><i data-lucide="undo-2"></i>显示原文</button>
        <button type="button" data-cancel><i data-lucide="square"></i>停止翻译</button>
        <label>原语言<select data-source aria-label="原语言"><option value="">自动检测</option></select></label>
        <button type="button" data-settings><i data-lucide="settings-2"></i>翻译服务设置</button>
      </div>
    </div>
    <form data-config hidden autocomplete="off">
      <label>Azure Translator 密钥<input data-key type="password" autocomplete="new-password" aria-label="Azure Translator 密钥"></label>
      <label>Azure 区域<input data-region type="text" placeholder="Global（全球）留空" autocomplete="off" aria-label="Azure 区域"></label>
      <label class="translation-consent"><input data-consent type="checkbox"><span>允许将待翻译页面及后续加载的文字发送给 Microsoft Translator，可能产生费用</span></label>
      <p data-config-status role="status"></p>
      <footer><button type="button" data-clear class="translation-icon" title="删除密钥" aria-label="删除密钥"><i data-lucide="trash-2"></i></button><button type="submit" class="translation-primary">保存</button></footer>
    </form>`;
  document.body.append(panel);
  const $ = selector => panel.querySelector(selector);
  for (const [code, name] of Object.entries(languages)) {
    $("[data-source]").add(new Option(name, code));
    $("[data-target]").add(new Option(name, code));
  }
  anchor.setAttribute("aria-controls", panel.id);
  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "false");
  let targetId = "";
  let polling = false;
  let busy = false;
  let phase = "original";
  let configured = false;
  let consent = false;
  let detected = "";
  let revision = 0;
  let localError = "";
  let translatedCount = 0;
  const errorMessage = error => String(error?.message || error || "").replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^(?:Error:\s*)+/, "");
  function updateAnchor(state) {
    const labels = { original: "翻译网页", translating: "正在翻译", translated: "已翻译 · 显示原文", stopped: "翻译已暂停", error: "翻译遇到问题" };
    const label = labels[state.phase] || labels.original;
    anchor.dataset.translationState = state.phase;
    anchor.title = `${label}${state.count ? `（已译 ${state.count} 处）` : ""}`;
    anchor.setAttribute("aria-label", anchor.title);
    anchor.setAttribute("aria-busy", String(state.phase === "translating"));
  }
  let offerTimer;
  let offerRevision = 0;
  const offered = new Set();
  function pageChanged() {
    const sequence = ++offerRevision;
    clearTimeout(offerTimer);
    if (isOpen()) panel.hidePopover();
    updateAnchor({ phase: "original" });
    void poll();
    const tab = currentTab();
    if (!tab || !/^https?:\/\//.test(tab.url || "")) return;
    const id = tab.targetId;
    const url = tab.url;
    const key = `${id}\n${url}`;
    if (offered.has(key)) return;
    offerTimer = setTimeout(async () => {
      try {
        const [description, settings, state] = await Promise.all([
          invoke("translation.describe", { targetId: id }),
          invoke("translation.settings", { targetId: id }),
          invoke("translation.status", { targetId: id }),
        ]);
        if (sequence !== offerRevision || currentTab()?.targetId !== id || currentTab()?.url !== url || isOpen()) return;
        const language = String(description.language || "").toLowerCase().split(/[-_]/)[0];
        const target = String(settings.target || "zh-Hans").toLowerCase().split("-")[0];
        if (!description.supported || !language || language === target || state.phase !== "original") return;
        if (document.querySelector(":modal") || document.activeElement?.matches("input,textarea,[contenteditable=true]")) return;
        offered.add(key);
        if (offered.size > 300) offered.delete(offered.values().next().value);
        await open();
      } catch { /* Navigation can invalidate the document before inspection. */ }
    }, 900);
  }
  const isOpen = () => panel.matches(":popover-open");
  function position() {
    if (!isOpen()) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.right - width + 10, innerWidth - width - 12))}px`;
    const top = Math.min(rect.bottom + 8, innerHeight - 120);
    panel.style.top = `${Math.max(8, top)}px`;
    panel.style.maxHeight = `${Math.max(100, innerHeight - top - 12)}px`;
  }
  function sync() {
    $("[data-translate]").disabled = busy;
    $("[data-translate]").textContent = phase === "original" ? "翻译" : phase === "error" || phase === "stopped" ? "继续翻译" : phase === "translating" ? "暂停翻译" : "显示原文";
    $("[data-target]").disabled = busy || phase !== "original";
    $("[data-source]").disabled = busy || phase !== "original";
    $("[data-restore]").disabled = busy || phase === "original";
    $("[data-cancel]").disabled = busy || !["translated", "translating"].includes(phase);
    $("[data-config] button[type=submit]").disabled = busy;
    $("[data-clear]").disabled = busy;
    const language = languages[$("[data-source]").value || detected];
    $("#translation-heading").textContent = !$("[data-config]").hidden ? "翻译服务" : phase === "original"
      ? language ? `翻译${language}页面？` : "翻译此页？"
      : phase === "translating" ? "正在翻译…" : phase === "translated" ? "此页已翻译" : "翻译已暂停";
    if (currentTab()?.targetId === targetId) updateAnchor({ phase, count: translatedCount });
  }
  const render = state => {
    phase = state.phase;
    translatedCount = state.count || 0;
    const message = localError || errorMessage(state.error) || (phase === "translating"
      ? translatedCount ? `已翻译 ${translatedCount} 处，正在继续…` : "正在翻译当前页面…"
      : phase === "translated" ? translatedCount ? `已翻译 ${translatedCount} 处` : "未找到可翻译的文字"
      : phase === "stopped" ? `已暂停，保留 ${translatedCount} 处译文` : "");
    $("[data-status]").textContent = message;
    $("[data-status]").hidden = !message;
    sync();
  };
  const action = async operation => {
    if (busy) return;
    const version = revision;
    const id = targetId;
    busy = true;
    localError = "";
    sync();
    try { await operation(id, () => version === revision && isOpen()); }
    catch (error) { if (version === revision) { localError = errorMessage(error); render({ phase, count: translatedCount }); } }
    finally { if (version === revision) { busy = false; sync(); position(); } }
  };
  function showConfig(show) {
    $("[data-config]").hidden = !show;
    $("[data-main]").hidden = show;
    $("[data-back]").hidden = !show;
    $("[data-more-menu]").hidden = true;
    $("[data-more]").setAttribute("aria-expanded", "false");
    sync();
    position();
    if (show) $("[data-key]").focus();
  }
  const applySettings = settings => {
    configured = settings.configured;
    consent = settings.cloudConsent;
    $("[data-consent]").checked = consent;
    $("[data-region]").value = settings.region;
    $("[data-target]").value = settings.target;
    $("[data-key]").placeholder = configured ? "已配置 · 无需重复填写" : settings.keyStatus === "unreadable" ? "密钥无法读取，请重新填写" : "尚未配置";
    $("[data-config-status]").textContent = configured ? "密钥已加密保存，本机可读取" : settings.keyStatus === "unreadable" ? "当前应用无法解密已保存的密钥，请重新保存。" : "当前 Profile 尚未配置密钥";
    sync();
  };
  const poll = async () => {
    if (polling) return;
    const tab = currentTab();
    if (!tab || !/^https?:\/\//.test(tab.url || "")) { updateAnchor({ phase: "original" }); return; }
    polling = true;
    const version = revision;
    const id = tab.targetId;
    const url = tab.url;
    if (isOpen() && id !== targetId) panel.hidePopover();
    try {
      const state = await invoke("translation.status", { targetId: id });
      if (currentTab()?.targetId !== id || currentTab()?.url !== url) return;
      updateAnchor(state);
      if (version === revision && isOpen() && id === targetId) render(state);
    } catch (error) {
      if (version === revision && isOpen()) { localError = errorMessage(error); render({ phase, count: translatedCount }); }
    } finally {
      polling = false;
    }
  };
  async function open() {
    const tab = currentTab();
    if (!tab || !/^https?:\/\//.test(tab.url || "")) { onError(new Error("请先打开一个普通网页")); return; }
    if (isOpen()) return;
    offered.add(`${tab.targetId}\n${tab.url}`);
    targetId = tab.targetId;
    const version = ++revision;
    localError = "";
    phase = "original";
    detected = "";
    $("[data-source]").value = "";
    $("[data-key]").value = "";
    configured = false;
    busy = true;
    showConfig(false);
    render({ phase });
    panel.showPopover();
    anchor.setAttribute("aria-expanded", "true");
    position();
    try {
      const [settings, state, description] = await Promise.all([
        invoke("translation.settings", { targetId }), invoke("translation.status", { targetId }),
        invoke("translation.describe", { targetId }),
      ]);
      if (version !== revision || !isOpen()) return;
      const language = String(description.language || "").replace("_", "-");
      detected = Object.hasOwn(languages, language) ? language : language.split("-")[0].toLowerCase();
      applySettings(settings);
      render(state);
      void poll();
    } catch (error) { if (version === revision) { localError = errorMessage(error); render({ phase }); } }
    finally { if (version === revision) { busy = false; sync(); } }
  }
  $("[data-close]").onclick = () => panel.hidePopover();
  panel.addEventListener("beforetoggle", event => {
    if (event.newState === "closed") {
      revision++;
      $("[data-key]").value = "";
      anchor.setAttribute("aria-expanded", "false");
    }
  });
  window.addEventListener("resize", position);
  $("[data-back]").onclick = () => showConfig(false);
  $("[data-settings]").onclick = () => showConfig(true);
  $("[data-source]").onchange = sync;
  $("[data-more]").onclick = () => {
    const menu = $("[data-more-menu]");
    menu.hidden = !menu.hidden;
    $("[data-more]").setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button:not(:disabled)")?.focus();
  };
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("[data-more-menu]").hidden) {
      event.preventDefault();
      $("[data-more-menu]").hidden = true;
      $("[data-more]").setAttribute("aria-expanded", "false");
      $("[data-more]").focus();
    }
  });
  $("[data-translate]").onclick = () => action(async (id, current) => {
    if (phase === "translated") {
      const state = await invoke("translation.restore", { targetId: id });
      if (current()) { render(state); panel.hidePopover(); }
      return;
    }
    if (phase === "translating") {
      const state = await invoke("translation.cancel", { targetId: id });
      if (current()) render(state);
      return;
    }
    if (!configured || !consent) { showConfig(true); return; }
    const source = $("[data-source]").value;
    const targetLanguage = $("[data-target]").value;
    if (!current()) return;
    const method = phase === "original" ? "translation.start" : "translation.resume";
    const state = await invoke(method, { targetId: id, source, targetLanguage, consent: true });
    if (current()) { render(state); panel.hidePopover(); }
  });
  $("[data-restore]").onclick = () => action(async (id, current) => {
    const state = await invoke("translation.restore", { targetId: id });
    if (current()) { render(state); showConfig(false); }
  });
  $("[data-cancel]").onclick = () => action(async (id, current) => {
    const state = await invoke("translation.cancel", { targetId: id });
    if (current()) render(state);
  });
  $("[data-config]").onsubmit = event => {
    event.preventDefault();
    void action(async (id, current) => {
      const key = $("[data-key]").value;
      $("[data-key]").value = "";
      const settings = await invoke("translation.saveSettings", {
        targetId: id, key, region: $("[data-region]").value.trim(), target: $("[data-target]").value, cloudConsent: $("[data-consent]").checked,
      });
      if (current()) { applySettings(settings); showConfig(false); }
    });
  };
  $("[data-clear]").onclick = () => action(async (id, current) => {
    const settings = await invoke("translation.saveSettings", {
      targetId: id, clearKey: true, region: $("[data-region]").value.trim(), target: $("[data-target]").value, cloudConsent: false,
    });
    if (current()) applySettings(settings);
  });
  anchor.onclick = () => { if (isOpen()) panel.hidePopover(); else void open(); };
  window.setInterval(() => void poll(), 800);
  window.lucide.createIcons({ root: panel });
  return { open, pageChanged };
}
