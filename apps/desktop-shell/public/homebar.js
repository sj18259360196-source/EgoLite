const input = document.querySelector("#homebar-input");
const submit = document.querySelector("#homebar-submit");
let mode = "browse";
let pageContext = null;
const contextSelection = { page: true, selection: false, screenshot: false };

window.lucide.createIcons();
input.focus();

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;
    for (const candidate of document.querySelectorAll("[data-mode]")) {
      candidate.classList.toggle("active", candidate === button);
      candidate.setAttribute("aria-selected", String(candidate === button));
    }
    input.focus();
    updateContextControls();
  });
}

for (const button of document.querySelectorAll("[data-context]")) {
  button.addEventListener("click", () => {
    const name = button.dataset.context;
    if (button.disabled) return;
    contextSelection[name] = !contextSelection[name];
    updateContextControls();
    input.focus();
  });
}

window.egoHomeBar.onContext((context) => {
  pageContext = context;
  contextSelection.page = context.hasPage === true;
  contextSelection.selection = context.hasSelection === true;
  contextSelection.screenshot = false;
  document.querySelector("#homebar-context-title").textContent = context.title || "Ctrl+Shift+Space";
  document.querySelector("#homebar-context-title").title = context.url || "";
  updateContextControls();
});

submit.addEventListener("click", send);
input.addEventListener("input", () => { submit.disabled = !input.value.trim(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void send();
  if (event.key === "Escape") void window.egoHomeBar.dismiss();
  if (event.key === "Tab") {
    event.preventDefault();
    const modes = ["browse"];
    const index = modes.indexOf(mode);
    document.querySelector(`[data-mode="${modes[(index + 1) % modes.length]}"]`).click();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void window.egoHomeBar.dismiss();
});

async function send() {
  const text = input.value.trim();
  if (!text) return;
  submit.disabled = true;
  try {
    await window.egoHomeBar.submit({
      mode,
      text,
      context: pageContext ? { targetId: pageContext.targetId, ...contextSelection } : undefined,
    });
    input.value = "";
  } finally {
    submit.disabled = false;
  }
}

function updateContextControls() {
  const browse = mode === "browse";
  for (const button of document.querySelectorAll("[data-context]")) {
    const name = button.dataset.context;
    const available = !browse && pageContext?.hasPage
      && (name !== "selection" || pageContext.hasSelection)
      ;
    button.disabled = !available;
    button.classList.toggle("active", available && contextSelection[name]);
    button.setAttribute("aria-pressed", String(available && contextSelection[name]));
  }
}
