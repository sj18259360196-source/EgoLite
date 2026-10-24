const KEY_DOWN_TYPES = new Set(["keyDown", "rawKeyDown", "keydown"]);

function normalizedKey(input = {}) {
  const key = String(input.key || "").toLowerCase();
  if (key === "add") return "+";
  if (key === "subtract") return "-";
  return key;
}

export function browserCommandForInput(input = {}) {
  if (input.type && !KEY_DOWN_TYPES.has(input.type)) return "";

  const key = normalizedKey(input);
  const control = input.control === true || input.ctrlKey === true;
  const meta = input.meta === true || input.metaKey === true;
  const alt = input.alt === true || input.altKey === true;
  const shift = input.shift === true || input.shiftKey === true;
  const commandModifier = control || meta;

  // Ctrl+Alt is commonly produced by AltGr and must remain available to pages.
  if (control && alt && !meta) return "";

  if (commandModifier && !alt) {
    if (key === "i" && shift) return "toggle-devtools";
    if (key === "c" && shift) return "inspect-element";
    if (key === "tab") return shift ? "previous-recent-tab" : "next-recent-tab";
    if (key === "pageup") return shift ? "move-tab-left" : "previous-tab";
    if (key === "pagedown") return shift ? "move-tab-right" : "next-tab";
    if (key === "t") return shift ? "restore-tab" : "new-tab";
    if (key === "w") return shift ? "close-window" : "close-tab";
    if (key === "r") return shift ? "reload-bypass-cache" : "reload";
    if (key === "g") return shift ? "find-previous" : "find-next";
    if (key === "a" && shift) return "tab-overview";
    if (["l", "e", "k"].includes(key)) return "focus-address";
    if (key === "f" && !shift) return "find";
    if (key === "p" && !shift) return "print";
    if (key === "h" && !shift) return "history";
    if (key === "j" && !shift) return "downloads";
    if (key === "d" && !shift) return "bookmark";
    if (key === "o" && shift) return "favorites";
    if (key === "b" && shift) return "toggle-favorites-bar";
    if (key === "0") return "zoom-reset";
    if (key === "+" || key === "=") return "zoom-in";
    if (key === "-") return "zoom-out";
    if (/^[1-9]$/.test(key) && !shift) return `activate-tab-${key}`;
  }

  if (alt && !commandModifier) {
    if (key === "arrowleft") return "back";
    if (key === "arrowright") return "forward";
    if (key === "d") return "focus-address";
  }

  if (!commandModifier && !alt) {
    if (key === "f12" && !shift) return "toggle-devtools";
    if (key === "f5") return shift ? "reload-bypass-cache" : "reload";
    if (key === "f6") return "focus-address";
    if (key === "f11") return "toggle-fullscreen";
  }

  return "";
}
