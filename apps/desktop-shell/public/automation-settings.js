export function bindAutomationSettings({ invoke, currentProfile, onError }) {
  const root = document.querySelector("#automation-settings");
  const $ = selector => root.querySelector(selector);
  let profileId = "default";
  let revision = 0;
  let busy = false;
  const status = message => { $("[data-status]").textContent = message; };
  function lock(value) {
    busy = value;
    for (const element of root.querySelectorAll("input, select, button")) element.disabled = value;
  }
  function render(value) {
    $("[data-mode]").value = value.mode;
    $("[data-model]").value = value.model;
    $("[data-consent]").checked = value.cloudConsent;
    $("[data-origins]").value = value.allowedOrigins.join(", ");
    $("[data-key]").value = "";
    $("[data-key]").placeholder = value.configured ? "已保存，留空保留" : "尚未配置";
    $("[data-memory]").checked = value.memoryOnly;
    status(value.configured ? value.memoryOnly ? "密钥仅在本次运行中有效" : "密钥已加密保存" : "未配置 Jev，可使用确定性批处理");
  }
  async function refresh() {
    if (busy) return;
    const version = ++revision;
    profileId = currentProfile();
    $("[data-profile]").textContent = profileId;
    try {
      const settings = await invoke("automation.settings", { profileId });
      if (version === revision) render(settings);
      await refreshJobs();
    } catch (error) { if (version === revision) status(error.message); }
  }
  async function action(operation, requireProfile = true) {
    if (busy) return;
    lock(true);
    try {
      if (requireProfile && currentProfile() !== profileId) throw new Error("当前 Profile 已变化，请刷新后重试");
      await operation();
    }
    catch (error) { status(error.message); onError(error); }
    finally { lock(false); }
  }
  root.querySelector("form").onsubmit = event => {
    event.preventDefault();
    void action(async () => render(await invoke("automation.save", {
      profileId, mode: $("[data-mode]").value, model: $("[data-model]").value,
      key: $("[data-key]").value, memoryOnly: $("[data-memory]").checked,
      cloudConsent: $("[data-consent]").checked,
      allowedOrigins: $("[data-origins]").value.split(",").map(value => value.trim()).filter(Boolean),
    })));
  };
  $("[data-clear]").onclick = () => void action(async () => render(await invoke("automation.save", { profileId, clearKey: true })));
  $("[data-test]").onclick = () => void action(async () => {
    if ($("[data-key]").value.trim()) throw new Error("请先保存密钥");
    status("正在执行中英文决策测试");
    const result = await invoke("automation.test", { profileId });
    status(`${result.passed ? "测试通过" : "测试未通过"} · ${result.results.map(row => `${row.correct ? "通过" : "错误"} ${row.elapsedMs} ms`).join(" / ")} · ${result.results.reduce((sum, row) => sum + row.usage.input_tokens, 0)} tokens`);
  });
  function renderJobs(jobs) {
    const list = $("[data-jobs]");
    list.replaceChildren();
    for (const job of jobs.filter(job => !job.cancelled)) {
      const row = document.createElement("div");
      row.className = "automation-job";
      const description = document.createElement("span");
      description.textContent = `${job.taskId} · ${job.decisions} 次判断 · ${job.inputTokens} tokens`;
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "icon-button";
      stop.title = "停止任务";
      stop.setAttribute("aria-label", "停止任务");
      stop.innerHTML = '<i data-lucide="square"></i>';
      stop.onclick = () => void action(async () => { await invoke("automation.stop", { runId: job.runId }); await refreshJobs(); }, false);
      row.append(description, stop);
      list.append(row);
    }
    window.lucide?.createIcons({ root: list });
  }
  async function refreshJobs() { renderJobs(await invoke("automation.jobs")); }
  window.egoDesktop.onAutomationJobs?.(renderJobs);
  $("[data-refresh]").onclick = () => void refresh();
  return { refresh };
}
