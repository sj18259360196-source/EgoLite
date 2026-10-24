#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import * as helpers from "./helpers.js";
import {
  clearPreferredTarget,
  invalidateSession,
  setPreferredTarget
} from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import {
  bufferOutput,
  installLifecycleFlush,
  resetSink,
  setNoticeTrailer
} from "./output-sink.js";
import { runMain } from "./run.js";
import { emitUpdateNotice } from "./update-notice.js";
import { clearScopedReferenceState } from "./ref-state.js";
export * from "./helpers.js";
import { runMain as runMain2 } from "./run.js";
const SYNC_HELPERS = /* @__PURE__ */ new Set(["help"]);
const SYNC_FACTORY_HELPERS = /* @__PURE__ */ new Set([
  "page.locator",
  "page.getByRole",
  "page.getByText",
  "page.getByLabel",
  "page.getByPlaceholder",
  "page.getByAltText",
  "page.getByTitle",
  "page.getByTestId",
  "page.locator.first",
  "page.locator.nth",
  "page.locator.last",
  "page.locator.locator",
  "page.locator.getByRole",
  "page.locator.getByText",
  "page.locator.getByLabel",
  "page.locator.getByPlaceholder",
  "page.locator.getByAltText",
  "page.locator.getByTitle",
  "page.locator.getByTestId",
  "page.locator.filter"
]);
const SYNC_FACTORY_METHODS = /* @__PURE__ */ new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "first",
  "nth",
  "last",
  "filter"
]);
const LEGACY_GLOBAL_HELPERS = [
  "click",
  "dblclick",
  "hover",
  "drag",
  "wheel",
  "scrollIntoViewIfNeeded",
  "press",
  "insertText",
  "focus",
  "fill",
  "pressSequentially",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "dispatchEvent",
  "textContent",
  "innerText",
  "inputValue",
  "isChecked",
  "getAttribute",
  "count",
  "allInnerTexts",
  "allTextContents",
  "evaluateAll",
  "goto",
  "pageInfo",
  "listTabs",
  "currentTab",
  "switchTab",
  "openOrReuseTab",
  "closeTab",
  "snapshot",
  "snapshotRaw",
  "screenshot",
  "elementCenter",
  "drainEvents",
  "dialogInfo",
  "handleDialog",
  "waitForTimeout",
  "waitForLoadState",
  "waitForSelector",
  "waitForFunction",
  "waitForURL",
  "waitForRequest",
  "waitForResponse",
  "setInputFiles",
  "evaluate",
  "serverFetch",
  "browserFetch",
  "listTaskSpaces",
  "switchTaskSpace",
  "newTaskSpace",
  "useOrCreateTaskSpace",
  "claimTaskSpace",
  "completeTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "waitForAgentControl",
  "siteSkills",
  "siteSkillsForUrl",
  "runSiteTool",
  "runSiteBrowserTool",
  "learnContext"
];
const EGO_WRAPPED = /* @__PURE__ */ Symbol.for("egoBrowser.sdkWrapped");
function installEgoSdk(target = globalThis, options = {}) {
  if (!target || typeof target !== "object") {
    return target;
  }
  const context = options.context || helpers.helperContext();
  for (const name of LEGACY_GLOBAL_HELPERS) {
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      delete target[name];
    }
  }
  const readySignal = Promise.resolve(options.ready);
  let readyError = null;
  readySignal.catch((error) => {
    readyError = error;
  });
  const installed = {};
  for (const [name, value] of Object.entries(context)) {
    const exposed = SYNC_HELPERS.has(name) ? value : wrapReady(value, readySignal, () => readyError, [name]);
    Object.defineProperty(target, name, {
      value: exposed,
      writable: true,
      configurable: true,
      enumerable: false
    });
    installed[name] = exposed;
  }
  const usingDefaultLog = !options.cliLog;
  console.log = options.cliLog || createBufferedLog();
  if (usingDefaultLog) {
    resetSink();
    installLifecycleFlush(process.stdout);
  }
  if (target.ego && typeof target.ego === "object") {
    emitUpdateNotice(
      target.ego,
      usingDefaultLog ? setNoticeTrailer : (line) => options.cliLog?.(line)
    );
    target.ego.helpers = installed;
    target.ego.learnings = installed.site && typeof installed.site === "object" ? installed.site : {};
    if (!target.ego[EGO_WRAPPED]) {
      const previousReconnect = target.ego.onReconnect;
      target.ego.onReconnect = () => {
        clearScopedReferenceState();
        previousReconnect?.();
      };
      wrapCreateTab(target.ego);
      wrapInvalidating(target.ego, [
        "useTaskSpace",
        "closeTaskSpace",
        "createTaskSpace",
        "claimTaskSpace"
      ]);
      Object.defineProperty(target.ego, EGO_WRAPPED, {
        value: true,
        enumerable: false
      });
    }
    exposeEgoMethods(target, target.ego);
  }
  return target;
}
function wrapReady(value, readySignal, readyError, path = []) {
  if (typeof value === "function") {
    if (isSyncFactoryHelper(path)) {
      return (...args) => wrapReady(value(...args), readySignal, readyError, path);
    }
    return async (...args) => {
      await readySignal;
      const error = readyError();
      if (error) {
        throw error;
      }
      return value(...args);
    };
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const wrapped = {};
  for (const [key, child] of Object.entries(value)) {
    wrapped[key] = wrapReady(child, readySignal, readyError, [...path, key]);
  }
  return wrapped;
}
function isSyncFactoryHelper(path) {
  if (SYNC_FACTORY_HELPERS.has(path.join("."))) {
    return true;
  }
  return path[0] === "page" && SYNC_FACTORY_METHODS.has(path.at(-1) || "");
}
function createBufferedLog() {
  return (...args) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}
`);
  };
}
function isDirectCli() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}
function wrapInvalidating(ego, methodNames) {
  for (const name of methodNames) {
    const original = ego[name];
    if (typeof original !== "function") continue;
    const after = () => {
      clearScopedReferenceState();
      invalidateSession();
      clearPreferredTarget();
    };
    ego[name] = function(...args) {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          after();
          return value;
        });
      }
      after();
      return result;
    };
  }
}
function wrapCreateTab(ego) {
  const original = ego.createTab;
  if (typeof original !== "function") return;
  ego.createTab = function(...args) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        clearScopedReferenceState();
        invalidateSession();
        const id = value?.targetId || value?.result?.targetId;
        if (id) setPreferredTarget(id);
        return value;
      });
    }
    clearScopedReferenceState();
    invalidateSession();
    return result;
  };
}
function exposeEgoMethods(target, ego) {
  const skip = /* @__PURE__ */ new Set([
    "helpers",
    "learnings",
    "useTaskSpace",
    "createTaskSpace",
    "claimTaskSpace",
    "closeTaskSpace"
  ]);
  for (const key of Object.keys(ego)) {
    if (skip.has(key)) continue;
    if (key in target) continue;
    const value = ego[key];
    if (typeof value !== "function") continue;
    const bound = value.bind(ego);
    Object.defineProperty(target, key, {
      value: bound,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
}
export {
  installEgoSdk,
  runMain2 as runMain
};
