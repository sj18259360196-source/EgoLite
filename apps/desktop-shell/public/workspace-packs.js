export function bindWorkspacePacks({ invoke, getState, activeTask, openHome, refresh, toast }) {
  let selected = false;
  let layoutTimer = 0;
  let lastLayout = "";
  let lastVersion = "";
  const root = document.querySelector("#cos-pack-settings");
  const toggle = root.querySelector("[data-cos-enabled]");
  const surface = document.querySelector("#webview-stack");
  const describe = () => getState().cos;
  const overlays = [
    "dialog[open]", ".modal-backdrop:not([hidden])", "#browser-more-menu:not([hidden])",
    "#workspace-sidebar-backdrop:not([hidden])", "#downloads-panel:not([hidden])",
    "#history-panel:not([hidden])", "#extensions-panel:not([hidden])",
    "#credentials-panel:not([hidden])", "#tab-overview:not([hidden])",
  ].join(", ");
  const updateLayout = async () => {
    const bounds = surface.getBoundingClientRect();
    const visible = selected && describe()?.enabled && describe()?.workspace?.taskId === activeTask()
      && document.querySelector("#start-view").classList.contains("active")
      && !document.querySelector(overlays);
    const value = { visible: Boolean(visible), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
    const next = JSON.stringify(value);
    if (next === lastLayout) return;
    lastLayout = next;
    try { await invoke("cos.layout", value); }
    catch (error) { lastLayout = ""; toast(error.message, true); }
  };
  const schedule = () => {
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = 0;
      void updateLayout();
    }, 0);
  };
  new ResizeObserver(schedule).observe(surface);
  new MutationObserver(schedule).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class", "open", "hidden"] });
  window.addEventListener("resize", schedule);
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      await invoke(toggle.checked ? "cos.enable" : "cos.disable");
      selected = false;
      await refresh();
    } catch (error) { toast(error.message, true); }
    finally { render(); schedule(); }
  });
  root.querySelector("[data-cos-load]").addEventListener("click", async () => {
    try { await invoke("cos.load"); await refresh(); }
    catch (error) { toast(error.message, true); }
  });
  root.querySelector("[data-cos-install]").addEventListener("click", async () => {
    try { await invoke("cos.install"); await refresh(); }
    catch (error) { toast(error.message, true); }
  });
  root.querySelector("[data-cos-download]").addEventListener("click", async () => {
    try { await invoke("cos.download"); }
    catch (error) { toast(error.message, true); }
    finally { await refresh(); }
  });
  root.querySelector("[data-cos-cancel-install]").addEventListener("click", async () => {
    try { await invoke("cos.cancelInstall"); await refresh(); }
    catch (error) { toast(error.message, true); }
  });
  root.querySelector("[data-cos-open]").addEventListener("click", () => void openHome());
  root.querySelector("[data-cos-resume]").addEventListener("click", async () => {
    try { await invoke("cos.resumeTasks"); }
    catch (error) { toast(error.message, true); }
    finally { await refresh(); }
  });
  for (const action of ["update", "rollback"]) {
    root.querySelector(`[data-cos-${action}]`).addEventListener("click", async () => {
      try { await invoke(action === "update" && describe()?.builtin ? "cos.agentUpdate" : `cos.${action}`); }
      catch (error) { toast(error.message, true); }
      finally { lastLayout = ""; await refresh(); }
    });
  }
  for (const [selector, method] of [["check", "checkUpdate"], ["cancel-update", "cancelUpdate"], ["apply-update", "applyUpdate"]]) {
    root.querySelector(`[data-cos-${selector}]`)?.addEventListener("click", async () => {
      try { await invoke(`cos.${method}`); } catch (error) { toast(error.message, true); }
      finally { await refresh(); }
    });
  }

  function render() {
    const state = describe();
    if (state?.version !== lastVersion) { lastVersion = state?.version; lastLayout = ""; }
    const busy = state?.installing || state?.updating || state?.state === "starting" || state?.state === "stopping";
    const maintenance = state?.maintenance;
    const maintaining = ["preparing", "running", "cancelling", "applying"].includes(maintenance?.phase);
    toggle.checked = state?.enabled === true;
    toggle.disabled = busy || !state?.installed;
    for (const button of root.querySelectorAll("[data-cos-load], [data-cos-install]")) button.disabled = state?.enabled || busy;
    root.querySelector("[data-cos-update]").disabled = busy || !state?.installed || maintaining || maintenance?.phase === "ready";
    root.querySelector("[data-cos-rollback]").disabled = busy || !state?.canRollback;
    root.querySelector("[data-cos-download]").disabled = busy || state?.enabled;
    root.querySelector("[data-cos-download]").hidden = state?.builtin || state?.installed === true || state?.acquiring === true;
    for (const button of root.querySelectorAll("[data-cos-load], [data-cos-install]")) button.hidden = state?.builtin === true;
    const cancelUpdate = root.querySelector("[data-cos-cancel-update]");
    if (cancelUpdate) { cancelUpdate.hidden = !["running", "cancelling"].includes(maintenance?.phase); cancelUpdate.disabled = maintenance?.phase === "cancelling"; }
    const applyUpdate = root.querySelector("[data-cos-apply-update]");
    if (applyUpdate) { applyUpdate.hidden = maintenance?.phase !== "ready"; applyUpdate.disabled = busy || state?.enabled; }
    const maintenanceText = root.querySelector("[data-cos-maintenance]");
    if (maintenanceText) maintenanceText.textContent = maintenance?.error || ({ preparing: "准备维护目录", running: "Codex 正在更新", cancelling: "正在停止更新",
      ready: state?.enabled ? "候选版本已准备，停用 CoS 后可应用" : "候选版本已准备", applying: "正在切换版本", complete: "更新完成", cancelled: "更新已停止",
      interrupted: "更新已中断" })[maintenance?.phase] || (maintenance?.checkedAt ? maintenance.updateAvailable ? "有上游更新" : "上游版本未变化" : "");
    root.querySelector("[data-cos-cancel-install]").hidden = state?.acquiring !== true;
    root.querySelector("[data-cos-cancel-install]").disabled = state?.acquisition?.phase === "cancelling";
    root.querySelector("[data-cos-resume]").hidden = !state?.execution?.requiresResume;
    root.querySelector("[data-cos-resume]").disabled = busy || !state?.enabled;
    const status = root.querySelector("[data-cos-status]");
    status.title = state?.error || "";
    const errorText = state?.error?.includes("previous program and data restored") ? "更新失败，已恢复旧版" : state?.error ? "CoS 发生错误" : "";
    status.title = state?.error || "";
    const progress = state?.acquisition;
    const phase = { runtime: "准备运行工具", source: "下载 CoS", dependencies: "安装依赖",
      build: "正在构建", check: "检查启动", cancelling: "正在取消" }[progress?.phase];
    const percent = progress?.total ? ` ${Math.min(100, Math.floor(progress.received / progress.total * 100))}%` : "";
    status.textContent = phase ? phase + percent : state?.updating ? "正在更新或回退" : state?.installing ? "正在安装" : errorText || (state?.execution?.requiresResume ? "任务已暂停" : "") || ({
      stopped: state?.installed ? state?.builtin ? "已就绪" : "已安装" : "组件缺失", starting: "正在启动", ready: "运行中", stopping: "正在停止", failed: "启动失败",
    })[state?.state || "stopped"];
    root.querySelector("[data-cos-path]").textContent = [state?.version, state?.directory].filter(Boolean).join(" · ");
    root.querySelector("[data-cos-open]").disabled = busy || state?.state !== "ready";
    if (!state?.enabled) selected = false;
    schedule();
  }
  return {
    render,
    owns: task => Boolean(task && describe()?.enabled && task.taskId === describe()?.workspace?.taskId),
    selected: () => selected,
    hide() { selected = false; void updateLayout(); },
    async show() {
      await invoke("cos.openHome");
      selected = true;
      lastLayout = "";
      await updateLayout();
    },
    appendHomeTab(list) {
      const state = describe();
      if (!state?.enabled || state.workspace?.taskId !== activeTask()) return;
      const tab = document.createElement("div");
      tab.className = `browser-tab cos-home-tab ${selected ? "active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = 0;
      const image = document.createElement("img");
      image.className = "browser-tab-favicon";
      image.src = state.logo;
      image.alt = "";
      const label = document.createElement("span");
      label.className = "browser-tab-title";
      label.textContent = "Chat On Steroids";
      tab.append(image, label);
      tab.addEventListener("click", () => void openHome());
      tab.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); void openHome(); }
      });
      list.append(tab);
    },
  };
}
