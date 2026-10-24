import type { Check, ExtractInput } from "./schema.ts";

export interface ControlState { role: string; label: string; filled?: boolean; checked?: boolean; disabled: boolean; editable?: boolean; selectable?: boolean; matchingValueKeys?: string[] }
export interface Candidate { id: string; ref: string; role: string; label: string; state?: Omit<ControlState, "role" | "label"> }
const actionable = new Set(["button", "checkbox", "combobox", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "option"]);

export function parseCandidates(snapshot: string, limit = 80): Candidate[] {
  const candidates: Candidate[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^-\s+(\w+)(?:\s+("(?:[^"\\]|\\.)*"))?\s+\[(@[^\]\s]+)\]/.exec(line.trim());
    if (!match || !actionable.has(match[1]!)) continue;
    let label = "";
    try { label = match[2] ? JSON.parse(match[2]) as string : ""; } catch { continue; }
    candidates.push({ id: `e${candidates.length + 1}`, role: match[1]!, label: label.slice(0, 300), ref: match[3]! });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return ""; }
}

export function verificationExpression(checks: Check[]): string {
  return `(${verifyPage.toString()})(${JSON.stringify(checks)})`;
}

// This function is serialized into the page; it must not close over host state.
function verifyPage(checks: Check[]) {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  return checks.map(check => {
    try {
      if (check.kind === "url_contains") return { kind: check.kind, passed: location.href.includes(String(check.value)) };
      if (check.kind === "url_path_contains") return { kind: check.kind, passed: location.pathname.includes(String(check.value)) };
      if (check.kind === "title_contains") return { kind: check.kind, passed: document.title.includes(String(check.value)) };
      let nodes: Element[];
      if (check.kind === "filter_value" && !check.target) {
        nodes = Array.from(document.querySelectorAll("input,select,textarea,[aria-pressed],[aria-selected]")).filter(node =>
          node.getAttribute("name") === check.name || node.getAttribute("aria-label") === check.name);
      } else {
        if (!check.target) return { kind: check.kind, passed: null, reason: "missing_target" };
        nodes = Array.from(document.querySelectorAll(check.target));
      }
      if (check.kind === "count_equals") return { kind: check.kind, passed: nodes.length === check.value, count: nodes.length };
      if (check.kind === "hidden") return { kind: check.kind, passed: nodes.every(node => !visible(node)) };
      if (nodes.length !== 1) return { kind: check.kind, passed: nodes.length === 0 ? false : null, reason: "target_not_unique" };
      const node = nodes[0]!;
      if (check.kind === "visible") return { kind: check.kind, passed: visible(node) };
      if (check.kind === "text_contains") return { kind: check.kind, passed: visible(node) && (node.textContent || "").includes(String(check.value)) };
      if (check.kind === "checked") {
        if (!("checked" in node) && !["true", "false"].includes(node.getAttribute("aria-checked") || "")) {
          return { kind: check.kind, passed: null, reason: "checked_unavailable" };
        }
        const actual = "checked" in node ? Boolean(node.checked) : node.getAttribute("aria-checked") === "true";
        return { kind: check.kind, passed: actual === (check.value ?? true) };
      }
      if (check.kind === "value_equals" || check.kind === "filter_value") {
        if (!("value" in node)) return { kind: check.kind, passed: null, reason: "value_unavailable" };
        return { kind: check.kind, passed: String(node.value) === String(check.value) };
      }
      return { kind: check.kind, passed: null, reason: "unsupported_check" };
    } catch { return { kind: check.kind, passed: null, reason: "invalid_selector" }; }
  });
}

export function controlStateExpression(values: Record<string, string>): string {
  return `(${readControlStates.toString()})(${JSON.stringify(values)})`;
}

function readControlStates(values: Record<string, string>) {
  return Array.from(document.querySelectorAll("input,textarea,select,button,[role=checkbox],[role=switch]")).slice(0, 400).map(node => {
    const element = node as HTMLInputElement;
    const role = node.getAttribute("role") || (node.tagName === "BUTTON" ? "button" : node.tagName === "SELECT" ? "combobox"
      : element.type === "checkbox" ? "checkbox" : element.type === "search" ? "searchbox"
        : element.type === "number" ? "spinbutton" : "textbox");
    const labelledBy = (node.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
    const label = node.getAttribute("aria-label") || labelledBy
      || Array.from(element.labels || []).map(label => label.textContent || "").join(" ").trim()
      || node.getAttribute("placeholder") || node.getAttribute("title") || (role === "button" ? node.textContent?.trim() : "") || "";
    const state: ControlState = { role, label, disabled: element.disabled === true || node.getAttribute("aria-disabled") === "true" };
    if (["textbox", "searchbox", "spinbutton", "combobox"].includes(role)) {
      state.editable = ["INPUT", "TEXTAREA"].includes(node.tagName) && !element.readOnly && !["checkbox", "radio", "button", "submit", "reset", "file", "hidden"].includes(element.type);
      state.selectable = node.tagName === "SELECT";
    }
    if ("value" in element) {
      state.filled = Boolean(element.value);
      state.matchingValueKeys = Object.entries(values).filter(([, value]) => value === element.value).map(([key]) => key);
    }
    if (element.type === "checkbox" || element.type === "radio") state.checked = element.checked;
    else if (node.hasAttribute("aria-checked")) state.checked = node.getAttribute("aria-checked") === "true";
    return state;
  });
}

export function extractionExpression(input: ExtractInput, remaining: number): string {
  return `(${extractPage.toString()})(${JSON.stringify({ selector: input.selector, fields: input.fields, limit: remaining })})`;
}

function extractPage(input: { selector: string; fields: ExtractInput["fields"]; limit: number }) {
  const nodes = Array.from(document.querySelectorAll(input.selector));
  const rows = nodes.slice(0, input.limit).map(node => {
    const row: Record<string, string | null> = Object.create(null);
    for (const [key, field] of Object.entries(input.fields)) {
      const target = field.selector ? node.querySelector(field.selector) : node;
      if (!target) { row[key] = null; continue; }
      if (field.attribute === "text") row[key] = (target.textContent || "").trim().slice(0, 20000);
      else if (field.attribute === "value") {
        if (target instanceof HTMLInputElement && target.type === "password") row[key] = "[redacted]";
        else row[key] = "value" in target ? String(target.value).slice(0, 20000) : null;
      } else {
        const raw = target.getAttribute(field.attribute);
        if (raw && ["href", "src"].includes(field.attribute)) {
          try { row[key] = new URL(raw, location.href).href; } catch { row[key] = raw; }
        } else row[key] = raw;
      }
    }
    return row;
  });
  return { rows, availableRows: nodes.length, truncated: nodes.length > input.limit, url: location.href, title: document.title };
}
