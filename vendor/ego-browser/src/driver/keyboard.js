import { cdp } from "../cdp-eval.js";
import { browserCdp } from "../browser-runtime.js";
import { withHandle, resolveAndCall } from "./element-ops.js";
import { waitForSelector } from "./waits.js";
import { state } from "../state.js";
import {
  currentScopedReferenceAction,
  withScopedReferenceAction
} from "../scoped-reference-context.js";
const KEYS = {
  Enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { vk: 9, key: "Tab", code: "Tab", text: "	" },
  Backspace: { vk: 8, key: "Backspace", code: "Backspace", text: "" },
  Escape: { vk: 27, key: "Escape", code: "Escape", text: "" },
  Delete: { vk: 46, key: "Delete", code: "Delete", text: "" },
  " ": { vk: 32, key: " ", code: "Space", text: " " },
  ArrowLeft: { vk: 37, key: "ArrowLeft", code: "ArrowLeft", text: "" },
  ArrowUp: { vk: 38, key: "ArrowUp", code: "ArrowUp", text: "" },
  ArrowRight: { vk: 39, key: "ArrowRight", code: "ArrowRight", text: "" },
  ArrowDown: { vk: 40, key: "ArrowDown", code: "ArrowDown", text: "" },
  Home: { vk: 36, key: "Home", code: "Home", text: "" },
  End: { vk: 35, key: "End", code: "End", text: "" },
  PageUp: { vk: 33, key: "PageUp", code: "PageUp", text: "" },
  PageDown: { vk: 34, key: "PageDown", code: "PageDown", text: "" },
  Shift: { vk: 16, key: "Shift", code: "ShiftLeft", text: "" },
  Control: { vk: 17, key: "Control", code: "ControlLeft", text: "" },
  Alt: { vk: 18, key: "Alt", code: "AltLeft", text: "" },
  Meta: { vk: 91, key: "Meta", code: "MetaLeft", text: "" }
};
const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/;
const CTRL_MODIFIER = 2;
const META_MODIFIER = 4;
const INPUT_EVENT_DELAY_MS = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1e3;
function keyDefinition(key) {
  const special = KEYS[key];
  if (special) {
    return special;
  }
  if (key.length !== 1) {
    return { vk: 0, key, code: key, text: "" };
  }
  const vk = key.toUpperCase().codePointAt(0);
  const code = PRINTABLE_CODE_RE.test(key) ? `${/[0-9]/.test(key) ? "Digit" : "Key"}${key.toUpperCase()}` : key;
  return { vk, key, code, text: key };
}
function editingCommandsForKey(key, modifiers) {
  if ((modifiers === CTRL_MODIFIER || modifiers === META_MODIFIER) && key.toLowerCase() === "a") {
    return ["selectAll"];
  }
  if (modifiers === 0 && key === "Backspace") {
    return ["deleteBackward"];
  }
  if (modifiers === 0 && key === "Delete") {
    return ["deleteForward"];
  }
  return void 0;
}
const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8
};
const MODIFIER_KEYS = {
  Alt: "Alt",
  Control: "Control",
  ControlLeft: "Control",
  ControlRight: "Control",
  Meta: "Meta",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  Shift: "Shift",
  ShiftLeft: "Shift",
  ShiftRight: "Shift"
};
const pressedModifiers = /* @__PURE__ */ new Set();
function parseKeyCombo(combo) {
  const parts = combo.split("+");
  let key = parts.pop() ?? combo;
  if (key === "" && parts.length > 0) {
    key = "+";
    if (parts[parts.length - 1] === "") {
      parts.pop();
    }
  }
  let modifiers = 0;
  for (const name of parts) {
    if (name === "ControlOrMeta") {
      modifiers |= process.platform === "darwin" ? META_MODIFIER : CTRL_MODIFIER;
      continue;
    }
    const bit = MODIFIER_BITS[name];
    if (bit === void 0) {
      throw new Error(`press: unknown key modifier ${JSON.stringify(name)}`);
    }
    modifiers |= bit;
  }
  return { key, modifiers };
}
function modifierName(key) {
  return MODIFIER_KEYS[key];
}
function modifierBitForKey(key) {
  const name = modifierName(key);
  return name ? MODIFIER_BITS[name] : 0;
}
function activeModifierBits() {
  let bits = 0;
  for (const name of pressedModifiers) {
    bits |= MODIFIER_BITS[name] || 0;
  }
  return bits;
}
function keyEventBase(key, modifiers) {
  const { vk, code } = keyDefinition(key);
  return {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  };
}
async function down(keyCombo) {
  const { key, modifiers } = parseKeyCombo(keyCombo);
  const keyModifierBit = modifierBitForKey(key);
  const eventModifiers = activeModifierBits() | modifiers | keyModifierBit;
  await dispatchKeyEvent({
    type: "keyDown",
    ...keyEventBase(key, eventModifiers)
  });
  const name = modifierName(key);
  if (name) {
    pressedModifiers.add(name);
  }
}
async function up(keyCombo) {
  const { key, modifiers } = parseKeyCombo(keyCombo);
  const keyModifierBit = modifierBitForKey(key);
  const eventModifiers = activeModifierBits() | modifiers | keyModifierBit;
  await dispatchKeyEvent({
    type: "keyUp",
    ...keyEventBase(key, eventModifiers)
  });
  const name = modifierName(key);
  if (name) {
    pressedModifiers.delete(name);
  }
}
async function press(keyCombo) {
  const { key, modifiers } = parseKeyCombo(keyCombo);
  const effectiveModifiers = activeModifierBits() | modifiers;
  const downModifiers = effectiveModifiers | modifierBitForKey(key);
  const { vk, code, text } = keyDefinition(key);
  const base = {
    key,
    code,
    modifiers: effectiveModifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  };
  const commands = editingCommandsForKey(key, effectiveModifiers);
  const scopedAction = currentScopedReferenceAction();
  const probeId = await installKeyProbe(key);
  let dispatchError = null;
  let inputStarted = false;
  try {
    await dispatchKeyEvent({
      type: "keyDown",
      ...base,
      modifiers: downModifiers,
      ...text ? { text, unmodifiedText: text } : {},
      ...commands ? { commands } : {}
    });
    inputStarted = true;
    await inputEventDelay();
    await dispatchKeyEvent({
      type: "keyUp",
      ...base,
      modifiers: downModifiers
    });
  } catch (error) {
    if (!isKeyDispatchTimeout(error) && !error?.error_code) throw error;
    dispatchError = error;
  }
  const completed = await finishKeyProbe(probeId, {
    key,
    code,
    text,
    commands
  }, !scopedAction);
  if (dispatchError && !completed) {
    if (
      scopedAction
      && dispatchError?.error_code !== "EGO_ACTION_RESULT_UNKNOWN"
      && (inputStarted || isKeyDispatchTimeout(dispatchError))
    ) {
      throw Object.assign(new Error("Scoped key result is unknown after input may have been dispatched"), {
        error_code: "EGO_ACTION_RESULT_UNKNOWN",
        cause: dispatchError
      });
    }
    throw dispatchError;
  }
}
async function insertText(text) {
  await cdp("Input.insertText", { text });
}
async function typeText(text, options = {}) {
  await pressSequentially(String(text), options);
}
async function focus(selector) {
  return withScopedReferenceAction(selector, void 0, () => resolveAndCall(selector, "function(){this.focus();}"));
}
async function fill(selector, value, options = {}) {
  return withScopedReferenceAction(selector, options.timeout, () => fillOnce(selector, value, options));
}
async function fillOnce(selector, value, options = {}) {
  const clearFirst = options.clearFirst ?? true;
  const timeout = options.timeout ?? state.defaultTimeout;
  if (timeout > 0 && !await waitForSelector(selector, { timeout })) {
    throw new Error(`fill: element not found: ${JSON.stringify(selector)}`);
  }
  await withHandle(selector, async ({ objectId, sessionId }) => {
    // Native value setters also work in background tabs and notify controlled inputs.
    const assigned = await cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(value, clearFirst) {
        if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) || this.type === 'file') return { handled: false };
        if (this.disabled || this.readOnly) throw new Error('fill target is not editable');
        this.focus();
        const start = this.selectionStart ?? this.value.length;
        const end = this.selectionEnd ?? start;
        const next = clearFirst ? value : this.value.slice(0, start) + value + this.value.slice(end);
        const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, next);
        this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { handled: true, matched: this.value === next };
      }`,
      arguments: [{ value: String(value) }, { value: clearFirst }],
      returnByValue: true,
    }, sessionId);
    if (assigned.exceptionDetails) throw new Error("fill target rejected the value");
    if (assigned.result?.value?.handled) {
      if (!assigned.result.value.matched) throw new Error("fill value did not persist");
      return;
    }
    const focusSource = clearFirst ? "function(){this.focus(); if(this.isContentEditable){const range=document.createRange();range.selectNodeContents(this);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);}else if(typeof this.select==='function') this.select();}" : "function(){this.focus();}";
    await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: focusSource,
        objectId,
        returnByValue: true,
        awaitPromise: false
      },
      sessionId
    );
    if (clearFirst) {
      await cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function(){if(this.isContentEditable){this.textContent='';}else if('value' in this){this.value='';}else{throw new Error('fill target is not editable');} this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}",
          objectId,
          returnByValue: true,
          awaitPromise: false
        },
        sessionId
      );
    }
    const scopedAction = currentScopedReferenceAction();
    if (scopedAction) {
      await cdp(
        "DOM.focus",
        { backendNodeId: scopedAction.binding.backendNodeId },
        scopedAction.binding.sessionId
      );
    }
    await cdp("Input.insertText", { text: value }, sessionId);
    await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: "function(){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));}",
        objectId,
        returnByValue: true,
        awaitPromise: false
      },
      sessionId
    );
  });
}
async function pressSequentially(selectorOrText, textOrOptions = void 0, options = {}) {
  if (typeof textOrOptions === "string") {
    const text = textOrOptions;
    const additionalExecutionMs = plannedSequentialInputDuration(text, options);
    return withScopedReferenceAction(selectorOrText, options.timeout, async () => {
      await focusWithTimeout(selectorOrText, options.timeout);
      await pressSequentiallyText(text, options);
    }, { additionalExecutionMs });
  }
  return pressSequentiallyText(selectorOrText, textOrOptions || {});
}
async function pressSequentiallyText(text, effectiveOptions) {
  for (const char of String(text)) {
    if (char.length > 1) await insertText(char);
    else await press(char);
    const delay = Number(effectiveOptions.delay ?? 0);
    if (delay > 0) {
      await state.sleep(delay);
    }
  }
}
function plannedSequentialInputDuration(text, options = {}) {
  const characters = [...String(text)];
  const delay = Number(options.delay ?? 0);
  const effectiveDelay = Math.max(0, delay);
  const keyEventCharacters = characters.filter((character) => character.length === 1).length;
  return keyEventCharacters * INPUT_EVENT_DELAY_MS + characters.length * effectiveDelay;
}
async function pressOnSelector(selector, keyCombo, options = {}) {
  return withScopedReferenceAction(selector, options.timeout, async () => {
    await focusWithTimeout(selector, options.timeout);
    await press(keyCombo);
  });
}
async function check(selector) {
  await setChecked(selector, true);
}
async function uncheck(selector) {
  await setChecked(selector, false);
}
async function setChecked(selector, checked) {
  return withScopedReferenceAction(selector, void 0, () => resolveAndCall(
    selector,
    `function(checked){
      if (!(this instanceof HTMLInputElement) || (this.type !== "checkbox" && this.type !== "radio")) {
        throw new Error("setChecked target must be a checkbox or radio input");
      }
      if (this.type === "radio" && !checked) {
        throw new Error("setChecked cannot uncheck a radio input");
      }
      if (this.checked === checked) return;
      this.checked = checked;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }`,
    [Boolean(checked)]
  ));
}
async function selectOption(selector, values) {
  return withScopedReferenceAction(selector, void 0, async () => {
    const { result } = await resolveAndCall(
    selector,
    `function(values){
      if (!(this instanceof HTMLSelectElement)) {
        throw new Error("selectOption target must be a select element");
      }
      const wanted = Array.isArray(values) ? values : [values];
      const selected = [];
      for (const option of this.options) option.selected = false;
      for (const wantedOption of wanted) {
        let match;
        if (typeof wantedOption === "object" && wantedOption !== null) {
          if (typeof wantedOption.index === "number") match = this.options[wantedOption.index];
          if (!match && wantedOption.value !== undefined) {
            match = [...this.options].find((option) => option.value === String(wantedOption.value));
          }
          if (!match && wantedOption.label !== undefined) {
            match = [...this.options].find((option) => option.label === String(wantedOption.label) || option.text === String(wantedOption.label));
          }
        } else {
          match = [...this.options].find((option) => option.value === String(wantedOption));
        }
        if (!match) throw new Error("selectOption could not find option " + JSON.stringify(wantedOption));
        match.selected = true;
        selected.push(match.value);
        if (!this.multiple) break;
      }
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return selected;
    }`,
    [values]
  );
    return result.result?.value || [];
  });
}
async function focusWithTimeout(selector, timeout = state.defaultTimeout) {
  if (timeout > 0 && !await waitForSelector(selector, { timeout })) {
    throw new Error(`focus: element not found: ${JSON.stringify(selector)}`);
  }
  await focus(selector);
}
const DISPATCH_EVENT_SOURCE = `function(type, eventInit){
  const init = { bubbles: true, cancelable: true, composed: true, ...(eventInit || {}) };
  const category = {
    auxclick: "mouse", click: "mouse", dblclick: "mouse", mousedown: "mouse",
    mouseenter: "mouse", mouseleave: "mouse", mousemove: "mouse", mouseout: "mouse",
    mouseover: "mouse", mouseup: "mouse", mousewheel: "mouse",
    keydown: "keyboard", keyup: "keyboard", keypress: "keyboard", textInput: "keyboard",
    pointerover: "pointer", pointerout: "pointer", pointerenter: "pointer",
    pointerleave: "pointer", pointerdown: "pointer", pointerup: "pointer",
    pointermove: "pointer", pointercancel: "pointer", gotpointercapture: "pointer",
    lostpointercapture: "pointer",
    focus: "focus", blur: "focus",
    dragstart: "drag", drag: "drag", dragend: "drag", dragenter: "drag",
    dragleave: "drag", dragover: "drag", dragexit: "drag", drop: "drag",
    wheel: "wheel"
  };
  let event;
  switch (category[type]) {
    case "mouse": event = new MouseEvent(type, init); break;
    case "keyboard": event = new KeyboardEvent(type, init); break;
    case "pointer": event = new PointerEvent(type, init); break;
    case "focus": event = new FocusEvent(type, init); break;
    case "drag": event = new DragEvent(type, init); break;
    case "wheel": event = new WheelEvent(type, init); break;
    default: event = new Event(type, init); break;
  }
  this.dispatchEvent(event);
}`;
async function dispatchEvent(selector, type, eventInit = {}) {
  if (typeof type !== "string" || type === "") {
    throw new Error("dispatchEvent requires an event type string");
  }
  return withScopedReferenceAction(selector, void 0, () => (
    resolveAndCall(selector, DISPATCH_EVENT_SOURCE, [type, eventInit])
  ));
}
function inputEventDelay() {
  return new Promise((resolve) => setTimeout(resolve, INPUT_EVENT_DELAY_MS));
}
async function dispatchKeyEvent(params) {
  await browserCdp(
    "Input.dispatchKeyEvent",
    params,
    void 0,
    INPUT_DISPATCH_TIMEOUT_MS
  );
}
async function installKeyProbe(key) {
  if (!canProbeInputFallback()) return null;
  const id = `key_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp("Runtime.evaluate", {
      expression: `(() => {
      window.__egoBrowserInputProbes ||= {};
      const probe = { seen: false };
      probe.handler = (event) => {
        if (event.isTrusted && event.key === ${JSON.stringify(key)}) probe.seen = true;
      };
      document.addEventListener("keydown", probe.handler, true);
      window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
      return true;
    })()`,
      returnByValue: true,
      awaitPromise: false
    });
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function finishKeyProbe(id, definition, allowFallback = true) {
  if (!id) return false;
  await inputEventDelay();
  try {
    const result = await cdp("Runtime.evaluate", {
      expression: `(() => {
      const probes = window.__egoBrowserInputProbes || {};
      const probe = probes[${JSON.stringify(id)}];
      if (!probe) return { seen: false, fallback: false };
      document.removeEventListener("keydown", probe.handler, true);
      delete probes[${JSON.stringify(id)}];
      if (probe.seen) return { seen: true, fallback: false };
      if (!${JSON.stringify(allowFallback)}) return { seen: false, fallback: false };

      const target = document.activeElement || document.body;
      const key = ${JSON.stringify(definition.key)};
      const code = ${JSON.stringify(definition.code)};
      const text = ${JSON.stringify(definition.text)};
      const commands = ${JSON.stringify(definition.commands || [])};
      const keyboardInit = {
        key,
        code,
        bubbles: true,
        cancelable: true,
        keyCode: ${JSON.stringify(keyDefinition(definition.key).vk)},
        which: ${JSON.stringify(keyDefinition(definition.key).vk)},
      };
      target.dispatchEvent(new KeyboardEvent("keydown", keyboardInit));

      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isEditable) {
        if (commands.includes("selectAll") && typeof target.select === "function") {
          target.select();
        } else if (commands.includes("deleteBackward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const from = start === end ? Math.max(0, start - 1) : start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentBackward",
          }));
          target.value = before.slice(0, from) + before.slice(end);
          target.setSelectionRange(from, from);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }));
        } else if (commands.includes("deleteForward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const to = start === end ? Math.min(target.value.length, end + 1) : end;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentForward",
          }));
          target.value = before.slice(0, start) + before.slice(to);
          target.setSelectionRange(start, start);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentForward",
          }));
        } else if (text) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }));
          target.value = before.slice(0, start) + text + before.slice(end);
          const next = start + text.length;
          target.setSelectionRange(next, next);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }));
        }
      }

      target.dispatchEvent(new KeyboardEvent("keyup", keyboardInit));
      return { seen: false, fallback: true };
    })()`,
      returnByValue: true,
      awaitPromise: false
    });
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}
function canProbeInputFallback() {
  return Boolean(globalThis.ego?.sendCDPMessage);
}
function isKeyDispatchTimeout(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP request timed out: Input\.dispatchKeyEvent/.test(message);
}
export {
  check,
  dispatchEvent,
  down,
  fill,
  focus,
  insertText,
  press,
  pressOnSelector,
  pressSequentially,
  selectOption,
  setChecked,
  typeText,
  uncheck,
  up
};
