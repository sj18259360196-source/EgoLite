export function bindDeveloperTools({ invoke, currentWebview, onError }) {
  const pane = document.querySelector("#devtools-pane");
  const surface = document.querySelector(".browser-surface");
  const host = document.querySelector("#devtools-host");
  const resizer = document.querySelector("#devtools-resizer");
  const status = document.querySelector("#devtools-status");
  let entries = [];
  let stateReceived = false;
  let width = Number(localStorage.getItem("ego-devtools-width")) || 480;
  let dragging = false;
  let frame = 0;
  let lastLayout = "";
  let layoutTail = Promise.resolve();
  const popups = [
    "dialog[open]", "#browser-more-menu", "#tab-overview", "#downloads-panel",
    "#history-panel", "#extensions-panel", "#credentials-panel", "#tab-context-menu",
    "#find-bar", "#tab-hover-preview", "#favorites-panel", ".bm-popup", "#translation-panel:popover-open",
  ].join(",");
  const clampWidth = value => Math.round(Math.max(280, Math.min(Math.max(280, surface.clientWidth - 220), value)));
  const viewId = () => { try { return currentWebview()?.getWebContentsId() || 0; } catch { return 0; } };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  const sendLayout = payload => {
    const key = JSON.stringify(payload);
    if (key === lastLayout) return;
    lastLayout = key;
    layoutTail = layoutTail.catch(() => {}).then(() => invoke("browser.devtools.layout", payload)).catch(error => {
      lastLayout = "";
      onError(error);
    });
  };
  function render() {
    frame = 0;
    const view = currentWebview();
    const id = viewId();
    const entry = entries.find(item => item.webContentsId === id);
    const open = Boolean(entry && view && !view.hidden && document.querySelector("#start-view").classList.contains("active"));
    if (pane.hidden === open) pane.hidden = !open;
    if (surface.classList.contains("devtools-open") !== open) surface.classList.toggle("devtools-open", open);
    const adjustedWidth = clampWidth(width);
    const styleWidth = `${adjustedWidth}px`;
    if (surface.style.getPropertyValue("--devtools-width") !== styleWidth) surface.style.setProperty("--devtools-width", styleWidth);
    if (resizer.getAttribute("aria-valuenow") !== String(adjustedWidth)) resizer.setAttribute("aria-valuenow", String(adjustedWidth));
    resizer.setAttribute("aria-valuemax", String(Math.max(280, surface.clientWidth - 220)));
    if (status.hidden !== Boolean(entry?.ready)) status.hidden = Boolean(entry?.ready);
    for (const button of pane.querySelectorAll("[data-devtools-panel]")) {
      const pressed = String(button.dataset.devtoolsPanel === entry?.panel);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    for (const button of pane.querySelectorAll("button:not(#devtools-close)")) button.disabled = !entry?.ready;
    const rect = host.getBoundingClientRect();
    const intersects = element => {
      if (element.hidden || !element.getClientRects().length) return false;
      const r = element.getBoundingClientRect();
      return r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
    };
    const obscured = [...document.querySelectorAll(popups)].some(intersects);
    sendLayout({
      webContentsId: id, visible: open && !dragging && !obscured && document.visibilityState !== "hidden",
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  const command = async method => {
    const id = viewId();
    if (!id) return;
    try { await invoke(`browser.devtools.${method}`, { webContentsId: id }); }
    catch (error) { onError(error); }
  };
  document.querySelector("#devtools-pick").addEventListener("click", () => void command("inspect"));
  document.querySelector("#devtools-copy").addEventListener("click", () => void command("copy"));
  document.querySelector("#devtools-close").addEventListener("click", () => void command("close"));
  for (const button of pane.querySelectorAll("[data-devtools-panel]")) {
    button.addEventListener("click", () => void command(button.dataset.devtoolsPanel));
  }
  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("devtools-resizing");
    localStorage.setItem("ego-devtools-width", String(width));
    schedule();
  };
  resizer.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("devtools-resizing");
    schedule();
  });
  resizer.addEventListener("pointermove", event => {
    if (!dragging) return;
    width = clampWidth(surface.getBoundingClientRect().right - event.clientX);
    schedule();
  });
  resizer.addEventListener("pointerup", finishDrag);
  resizer.addEventListener("pointercancel", finishDrag);
  resizer.addEventListener("lostpointercapture", finishDrag);
  window.addEventListener("blur", finishDrag);
  resizer.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    width = clampWidth(event.key === "Home" ? 280 : event.key === "End" ? surface.clientWidth - 220 : width + (event.key === "ArrowLeft" ? 32 : -32));
    localStorage.setItem("ego-devtools-width", String(width));
    schedule();
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["hidden", "open", "class", "style", "data-background", "data-target-id"],
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(surface);
  resize.observe(host);
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", schedule);
  window.egoDesktop.onDevToolsState(next => { stateReceived = true; entries = next; lastLayout = ""; schedule(); });
  void invoke("browser.devtools.state").then(next => {
    if (!stateReceived) { entries = next; schedule(); }
  }).catch(onError);
  schedule();
}
