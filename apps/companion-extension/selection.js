let timer;
let previous = "";

document.addEventListener("selectionchange", schedule, { passive: true });
document.addEventListener("mouseup", schedule, { passive: true });
document.addEventListener("keyup", schedule, { passive: true });

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(report, 180);
}

function report() {
  const text = window.getSelection()?.toString().trim() || "";
  if (text === previous) return;
  previous = text;
  chrome.runtime.sendMessage({ method: "content.selectionChanged", text }).catch(() => {});
}
