const { ipcRenderer } = require("electron");

let lastInteractionAt = 0;
for (const type of ["pointerdown", "keydown"]) {
  window.addEventListener(type, (event) => {
    if (!event.isTrusted || Date.now() - lastInteractionAt < 500) return;
    lastInteractionAt = Date.now();
    ipcRenderer.sendToHost("ego:user-interaction", { kind: type });
  }, { capture: true });
}

let scanTimer;
let lastFormState = "";
let lastSubmission = "";
let lastSubmissionAt = 0;

function isVisible(field) {
  return Boolean(field && !field.disabled && !field.readOnly && field.getClientRects().length);
}

function fieldIdentity(field) {
  if (!field) return "";
  return [field.name, field.id, field.autocomplete, field.type, field.placeholder]
    .map((value) => String(value || "").slice(0, 120))
    .join("|");
}

function usernameField(scope) {
  const fields = [...scope.querySelectorAll("input")].filter((field) => isVisible(field)
    && !["password", "hidden", "submit", "button", "checkbox", "radio", "file"].includes(String(field.type || "").toLowerCase()));
  return fields.find((field) => /email|user|login|account|phone|name/i.test(fieldIdentity(field))) || fields[0];
}

function describePasswordField(password) {
  const form = password.form || password.closest("form");
  const scope = form || document;
  const username = usernameField(scope);
  const formIndex = form ? [...document.forms].indexOf(form) : -1;
  return {
    origin: location.origin,
    username: String(username?.value || "").slice(0, 1_000),
    passwordEmpty: !password.value,
    passwordCount: [...scope.querySelectorAll('input[type="password"]')].filter(isVisible).length,
    formSignature: [formIndex, fieldIdentity(username), fieldIdentity(password)].join("::").slice(0, 2_000),
  };
}

function scanForms() {
  scanTimer = undefined;
  if (window.top !== window || !/^https?:$/i.test(location.protocol)) return;
  const password = [...document.querySelectorAll('input[type="password"]')].find(isVisible);
  const detail = password ? describePasswordField(password) : { origin: location.origin, passwordCount: 0 };
  const serialized = JSON.stringify(detail);
  if (serialized === lastFormState) return;
  lastFormState = serialized;
  ipcRenderer.sendToHost("ego:credentials-form", detail);
}

function scheduleScan(delay = 80) {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(scanForms, delay);
}

function submissionFromScope(scope) {
  const filledPasswords = [...scope.querySelectorAll('input[type="password"]')].filter((field) => isVisible(field) && field.value);
  const password = filledPasswords.at(-1);
  if (!password) return null;
  const form = password.form || password.closest("form");
  const resolvedScope = form || scope || document;
  const username = usernameField(resolvedScope);
  const detail = describePasswordField(password);
  return {
    ...detail,
    username: String(username?.value || "").slice(0, 1_000),
    password: String(password.value || "").slice(0, 20_000),
  };
}

function sendSubmission(scope) {
  if (window.top !== window || !/^https?:$/i.test(location.protocol)) return;
  const detail = submissionFromScope(scope || document);
  if (!detail?.password) return;
  const fingerprint = `${detail.origin}\n${detail.username}\n${detail.password}\n${detail.formSignature}`;
  const now = Date.now();
  if (fingerprint === lastSubmission && now - lastSubmissionAt < 1_500) return;
  lastSubmission = fingerprint;
  lastSubmissionAt = now;
  ipcRenderer.sendToHost("ego:credentials-submit", detail);
}

document.addEventListener("submit", (event) => sendSubmission(event.target), true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "password") {
    sendSubmission(event.target.form || document);
  }
}, true);
window.addEventListener("wheel", (event) => {
  if (window.top !== window || !event.ctrlKey || event.altKey) return;
  event.preventDefault();
  ipcRenderer.sendToHost("ego:browser-zoom-wheel", {
    deltaY: Number(event.deltaY) || 0,
    deltaMode: Number(event.deltaMode) || 0,
  });
}, { capture: true, passive: false });
document.addEventListener("click", (event) => {
  const button = event.target?.closest?.('button, input[type="submit"], input[type="button"], [role="button"]');
  if (!button) return;
  const label = [button.textContent, button.value, button.getAttribute("aria-label"), button.id, button.className].join(" ");
  if (button.type === "submit" || /login|log in|sign in|signin|登录|登陆|继续|下一步/i.test(label)) {
    sendSubmission(button.form || button.closest("form") || document);
  }
}, true);
document.addEventListener("focusin", (event) => {
  if (event.target instanceof HTMLInputElement) scheduleScan(0);
}, true);
document.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && ["password", "email", "text", "tel"].includes(event.target.type)) scheduleScan(100);
}, true);

ipcRenderer.on("ego:credentials-scan", () => {
  lastFormState = "";
  scheduleScan(0);
});

window.addEventListener("DOMContentLoaded", () => {
  scheduleScan(0);
  const observer = new MutationObserver(() => scheduleScan(120));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "disabled", "readonly", "type", "autocomplete"],
  });
});
