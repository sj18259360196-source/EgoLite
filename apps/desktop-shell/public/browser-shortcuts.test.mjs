import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { browserCommandForInput } from "./browser-shortcuts.js";

test("maps Chrome tab and address shortcuts", () => {
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "T" }), "new-tab");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, shift: true, key: "T" }), "restore-tab");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "L" }), "focus-address");
  assert.equal(browserCommandForInput({ type: "keyDown", alt: true, key: "d" }), "focus-address");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "F6" }), "focus-address");
  assert.equal(browserCommandForInput({ type: "keydown", ctrlKey: true, key: "Tab" }), "next-recent-tab");
});

test("maps navigation, reload, panels, and zoom shortcuts", () => {
  assert.equal(browserCommandForInput({ type: "keyDown", alt: true, key: "ArrowLeft" }), "back");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "F5" }), "reload");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, shift: true, key: "R" }), "reload-bypass-cache");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "H" }), "history");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "J" }), "downloads");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "+" }), "zoom-in");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "0" }), "zoom-reset");
});

test("preserves page editing and AltGr input", () => {
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "C" }), "");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "A" }), "");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, alt: true, key: "@" }), "");
  assert.equal(browserCommandForInput({ type: "keyUp", control: true, key: "T" }), "");
});

test("maps favorites shortcuts without stealing plain browser input", () => {
  assert.equal(browserCommandForInput({ type: "keydown", ctrlKey: true, shiftKey: true, key: "O" }), "favorites");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, shift: true, key: "B" }), "toggle-favorites-bar");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "B" }), "");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "O" }), "");
});

test("maps developer tools and element inspection without stealing copy", () => {
  assert.equal(browserCommandForInput({ type: "keyDown", key: "F12" }), "toggle-devtools");
  assert.equal(browserCommandForInput({ type: "keydown", key: "I", ctrlKey: true, shiftKey: true }), "toggle-devtools");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "C", control: true, shift: true }), "inspect-element");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "c", meta: true, shift: true }), "inspect-element");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "c", control: true }), "");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "F12", shift: true }), "");
  assert.equal(browserCommandForInput({ type: "keyUp", key: "F12" }), "");
  assert.equal(browserCommandForInput({ type: "keyDown", key: "C", control: true, shift: true, alt: true }), "");
});

test("distinguishes Chrome close and tab movement variants", () => {
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, key: "W" }), "close-tab");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, shift: true, key: "W" }), "close-window");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, shift: true, key: "PageUp" }), "move-tab-left");
  assert.equal(browserCommandForInput({ type: "keyDown", control: true, shift: true, key: "PageDown" }), "move-tab-right");
});

test("wires shortcuts through shell and guest WebContents", () => {
  const main = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../preload.cjs", import.meta.url), "utf8");
  const guestPreload = readFileSync(new URL("../webview-preload.cjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  assert.match(main, /mainWindow\.webContents\.on\("before-input-event"/);
  assert.match(main, /target\.on\("before-input-event", onBeforeInput\)/);
  assert.match(preload, /onBrowserCommand\(handler\)/);
  assert.match(guestPreload, /sendToHost\("ego:browser-zoom-wheel"/);
  assert.match(app, /event\.channel === "ego:browser-zoom-wheel"/);
  assert.match(app, /if \(event\.ctrlKey\) return;/);
});
