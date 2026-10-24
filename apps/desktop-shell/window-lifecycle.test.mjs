import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const createWindow = source.match(/function createWindow\(\) \{[^]*?\n\}/)[0]
  .replaceAll("import.meta.url", '"file:///desktop/main.mjs"');

function harness() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    isDestroyed() { return this.destroyed === true; }
    loadFile() {}
    maximize() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
  }
  const context = vm.createContext({ BrowserWindow, mainWindow: undefined,
    process: { env: {} }, isQuitting: false,
    join: (...parts) => parts.join("/"), dirname: (path) => path,
    fileURLToPath: (url) => url,
  });
  vm.runInContext(createWindow, context);
  return { context, windows, create: () => vm.runInContext("createWindow()", context) };
}

test("activation before startup creates only one main window, which closes to tray", () => {
  const { create, windows } = harness();
  create();
  create();
  assert.equal(windows.length, 1);
  let prevented = false;
  windows[0].emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(windows[0].visible, false);
});

test("old window events cannot hide or clear a replacement window", () => {
  const { create, windows, context } = harness();
  create();
  windows[0].destroyed = true;
  create();
  windows[0].emit("close", { preventDefault() {} });
  windows[0].emit("closed");
  assert.equal(windows[1].visible, true);
  assert.equal(context.mainWindow, windows[1]);
  context.isQuitting = true;
  windows[1].emit("close", { preventDefault() { assert.fail("quit was prevented"); } });
  windows[1].emit("closed");
  assert.equal(context.mainWindow, undefined);
});
