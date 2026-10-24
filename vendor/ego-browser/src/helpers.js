import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOverrides, state } from "./state.js";
import { assertNoEgoError, isEgoUserControlError } from "./ego-errors.js";
import { help as helpRuntime, formatHelp } from "./help-runtime.js";
import { cdp, decodeUnserializableJsValue, evaluate } from "./cdp-eval.js";
import * as pointer from "./driver/pointer.js";
import * as keyboard from "./driver/keyboard.js";
import * as locator from "./driver/locator.js";
import * as nav from "./driver/nav.js";
import * as observe from "./driver/observe.js";
import * as waits from "./driver/waits.js";
import * as files from "./driver/files.js";
import * as downloads from "./driver/downloads.js";
import { waitForDocumentLoad } from "./driver/load.js";
import { browserCdp, ensureSession, pageIdForSessionAlias } from "./browser-runtime.js";
import { browserFetch, serverFetch } from "./http.js";
import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
  siteSkillsForUrl as siteSkillsForUrlCore,
  wrapBrowserTool
} from "./learning/index.js";
import { NAME } from "./state.js";
import {
  currentScopedReferenceAction,
  withScopedReferenceAction
} from "./scoped-reference-context.js";
import { cdp as cdp2, evaluate as evaluate2 } from "./cdp-eval.js";
import {
  click,
  dblclick,
  hover,
  drag,
  wheel,
  scrollIntoViewIfNeeded
} from "./driver/pointer.js";
import {
  press,
  down,
  up,
  insertText,
  focus,
  fill,
  pressSequentially,
  check,
  uncheck,
  setChecked,
  selectOption,
  dispatchEvent
} from "./driver/keyboard.js";
import {
  textContent,
  innerText,
  inputValue,
  isChecked,
  isVisible,
  isHidden,
  isEnabled,
  isDisabled,
  isEditable,
  getAttribute,
  blur,
  boundingBox,
  count,
  allInnerTexts,
  allTextContents,
  innerHTML,
  evaluateLocator,
  evaluateAll
} from "./driver/locator.js";
import {
  INTERNAL_URL_PREFIXES,
  pageInfo,
  listTabs,
  currentTab,
  switchTab,
  openOrReuseTab,
  closeTab,
  goto,
  goBack,
  goForward,
  ensureRealTab,
  iframeTarget
} from "./driver/nav.js";
import {
  snapshot,
  snapshotRaw,
  screenshot,
  elementCenter,
  drainEvents,
  dialogInfo,
  handleDialog
} from "./driver/observe.js";
import {
  waitForTimeout,
  waitForLoadState,
  waitForSelector,
  waitForFunction,
  waitForURL,
  waitForRequest,
  waitForResponse
} from "./driver/waits.js";
import { setInputFiles } from "./driver/files.js";
import { browserFetch as browserFetch2, serverFetch as serverFetch2 } from "./http.js";
async function listTaskSpaces() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listTaskSpaces !== "function") {
    throw new Error("listTaskSpaces requires ego.listTaskSpaces");
  }
  return normalizeTaskSpaces(
    assertNoEgoError(await ego.listTaskSpaces(), "listTaskSpaces")
  );
}
function isAgentOwned(ownership) {
  return ownership === "agent" || ownership === "agentDelegatedToUser";
}
async function switchTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error("switchTaskSpace requires ego.useTaskSpace");
  }
  const space = await findTaskSpace(nameOrId);
  if (!isAgentOwned(space.ownership)) {
    throw new Error(
      `switchTaskSpace requires an agent-owned task space, got ownership ${JSON.stringify(space.ownership)}`
    );
  }
  return selectTaskSpace(ego, space, "switchTaskSpace");
}
async function newTaskSpace(name) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.createTaskSpace !== "function") {
    throw new Error("newTaskSpace requires ego.createTaskSpace");
  }
  const created = normalizeTaskSpace(
    assertNoEgoError(await ego.createTaskSpace(name), "newTaskSpace")
  );
  if (!created) {
    throw new Error("newTaskSpace returned an invalid task space");
  }
  taskSpaceNumericId(created, "newTaskSpace");
  return selectTaskSpace(ego, created, "newTaskSpace");
}
async function useOrCreateTaskSpace(nameOrId) {
  if (typeof globalThis.ego?.useOrCreateTaskSpace === "function") {
    return assertNoEgoError(await globalThis.ego.useOrCreateTaskSpace(nameOrId), "useOrCreateTaskSpace");
  }
  throw new Error("Atomic space.useOrCreate requires an updated Ego runtime");
}
async function resumeDelegatedTaskSpace(ego, space, op) {
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error(op + " requires ego.useTaskSpace");
  }
  const id = taskSpaceNumericId(space, op);
  try {
    const result = await ego.useTaskSpace(id);
    if (!isEgoUserControlError(result)) {
      assertNoEgoError(result, op);
      return space;
    }
  } catch (err) {
    if (!isEgoUserControlError(err)) throw err;
  }
  if (typeof ego.takeOverTaskSpace !== "function") {
    throw new Error(op + " requires ego.takeOverTaskSpace");
  }
  assertNoEgoError(await ego.takeOverTaskSpace(), op);
  return { ...space, ownership: "agent" };
}
async function claimTaskSpace(nameOrId) {
  const space = await findTaskSpace(nameOrId);
  return claimResolvedTaskSpace(space, "claimTaskSpace");
}
async function claimResolvedTaskSpace(space, op = "claimTaskSpace") {
  const ego = globalThis.ego;
  if (!ego || typeof ego.claimTaskSpace !== "function") {
    throw new Error(`${op} requires ego.claimTaskSpace`);
  }
  const id = taskSpaceNumericId(space, op);
  const claimed = normalizeTaskSpace(
    assertNoEgoError(await ego.claimTaskSpace(id, space.name), op)
  );
  if (!claimed) {
    throw new Error(`${op} returned an invalid task space`);
  }
  taskSpaceNumericId(claimed, op);
  return selectTaskSpace(ego, claimed, op);
}
async function selectTaskSpace(ego, space, op) {
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error(`${op} requires ego.useTaskSpace`);
  }
  assertNoEgoError(await ego.useTaskSpace(taskSpaceNumericId(space, op)), op);
  return space;
}
async function selectTaskSpaceIfProvided(ego, nameOrId, op = "taskSpace") {
  if (nameOrId === void 0) return;
  const match = await findTaskSpace(nameOrId);
  await selectTaskSpace(ego, match, op);
}
async function completeTaskSpace(nameOrId, options) {
  if (typeof nameOrId !== "string" && typeof nameOrId !== "number" || nameOrId === "") {
    throw new Error("completeTaskSpace requires a task space name or id");
  }
  if (!options || typeof options.keep !== "boolean") {
    throw new Error("completeTaskSpace requires { keep: boolean }");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("completeTaskSpace requires ego runtime");
  }
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) {
    throw new Error(`task space not found: ${nameOrId}`);
  }
  if (options.keep) {
    if (match.ownership === "user") {
      return { done: false, skipped: "user-owned" };
    }
    await selectTaskSpace(ego, match, "completeTaskSpace");
    if (typeof ego.completeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.completeTaskSpace");
    }
    assertNoEgoError(await ego.completeTaskSpace(), "completeTaskSpace");
  } else {
    if (match.ownership === "user") {
      await claimResolvedTaskSpace(match, "completeTaskSpace");
    } else {
      await selectTaskSpace(ego, match, "completeTaskSpace");
    }
    if (typeof ego.closeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.closeTaskSpace");
    }
    assertNoEgoError(await ego.closeTaskSpace(), "completeTaskSpace");
  }
  return { done: true };
}
async function handOffTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.handOffTaskSpace !== "function") {
    throw new Error("handOffTaskSpace requires ego.handOffTaskSpace");
  }
  if (nameOrId !== void 0) {
    const match = await findTaskSpace(nameOrId);
    if (match.ownership === "user") {
      return { done: false, skipped: "user-owned" };
    }
    await selectTaskSpace(ego, match, "handOffTaskSpace");
  }
  assertNoEgoError(await ego.handOffTaskSpace(), "handOffTaskSpace");
  return { done: true };
}
async function takeOverTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.takeOverTaskSpace !== "function") {
    throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
  }
  const space = nameOrId === undefined ? undefined : await findTaskSpace(nameOrId);
  assertNoEgoError(await ego.takeOverTaskSpace(space ? taskSpaceNumericId(space, "takeOverTaskSpace") : undefined), "takeOverTaskSpace");
}
async function waitForAgentControl(nameOrId, options = {}) {
  const space = await findTaskSpace(nameOrId);
  const ego = globalThis.ego;
  if (typeof ego?.waitForAgentControl !== "function") throw new Error("Control events require an updated Ego runtime");
  return ego.waitForAgentControl(taskSpaceNumericId(space, "waitForAgentControl"), { timeout: (options.timeout ?? 600) * 1000, signal: options.signal });
}
async function observeTaskSpace(nameOrId, targetId) {
  const space = await findTaskSpace(nameOrId);
  return globalThis.ego.observeTaskSpace(taskSpaceNumericId(space, "observe"), targetId);
}
async function requestControl(nameOrId) {
  const space = await findTaskSpace(nameOrId);
  return globalThis.ego.requestControl(taskSpaceNumericId(space, "requestControl"));
}
async function returnControl(nameOrId, requestId) {
  const space = await findTaskSpace(nameOrId);
  return globalThis.ego.returnControl(taskSpaceNumericId(space, "returnControl"), requestId);
}
function normalizeTaskSpaces(raw) {
  if (Array.isArray(raw?.taskSpaces)) {
    return raw.taskSpaces.map(normalizeTaskSpace).filter(Boolean);
  }
  throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
}
function normalizeTaskSpace(space) {
  const taskId = space?.taskId ?? space?.name ?? space?.id;
  if (taskId === void 0 || taskId === null || taskId === "") {
    return null;
  }
  return {
    ...space,
    taskId,
    id: space?.id ?? taskId,
    name: space?.name ?? taskId
  };
}
function taskSpaceNumericId(space, op) {
  if (typeof space?.id !== "number" || !Number.isFinite(space.id)) {
    throw new Error(
      `${op} requires a numeric task space id, got ${JSON.stringify(space?.id)}`
    );
  }
  return space.id;
}
async function findTaskSpace(nameOrId) {
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) throw new Error(`task space not found: ${nameOrId}`);
  return match;
}
function findMatchingTaskSpace(spaces, nameOrId) {
  if (typeof nameOrId === "number") {
    return spaces.find((space) => space.id === nameOrId);
  }
  const matches = spaces.filter(
    (space) => space.name === nameOrId || space.taskId === nameOrId
  );
  if (matches.length > 1) throw new Error(`Ambiguous task space name: ${nameOrId}; select by ID`);
  if (matches.length) return matches[0];
  if (/^\d+$/.test(nameOrId)) {
    const id = Number(nameOrId);
    if (Number.isFinite(id)) {
      return spaces.find((space) => space.id === id);
    }
  }
  return void 0;
}
async function siteSkillsForUrl(url) {
  return siteSkillsForUrlCore(url, {
    agentWorkspace: state.agentWorkspace()
  });
}
async function siteSkills(url = void 0) {
  const targetUrl = url ?? (await nav.pageInfo()).url ?? "";
  return siteSkillsForUrl(targetUrl);
}
async function runSiteTool(siteId, toolName, args = {}) {
  return runNodeSiteTool(siteId, toolName, args, helperContext(), {
    agentWorkspace: state.agentWorkspace()
  });
}
async function runSiteBrowserTool(siteId, toolName, args = {}) {
  const source = await loadBrowserToolSource(siteId, toolName, {
    agentWorkspace: state.agentWorkspace()
  });
  return evaluate(wrapBrowserTool(source, args));
}
async function learnContext(url = void 0) {
  const targetUrl = url ?? (await nav.pageInfo()).url ?? "";
  return loadLearnedContext(targetUrl, {
    agentWorkspace: state.agentWorkspace()
  });
}
function createLocator(selector) {
  return {
    selector,
    first: () => createLocator(nthSelector(selector, 0)),
    last: () => createLocator(`internal:last;${selector}`),
    nth: (index) => {
      const value = Number(index);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("locator.nth requires a non-negative integer");
      }
      return createLocator(nthSelector(selector, value));
    },
    locator: (child) => createLocator(scopedSelector(selector, locatorSelector(child))),
    getByRole: (role, options = {}) => createLocator(scopedSelector(selector, roleSelector(role, options))),
    getByText: (text, options = {}) => createLocator(
      scopedSelector(selector, textSelector("text", text, options))
    ),
    getByLabel: (text, options = {}) => createLocator(
      scopedSelector(selector, textSelector("label", text, options))
    ),
    getByPlaceholder: (text, options = {}) => createLocator(
      scopedSelector(selector, textSelector("placeholder", text, options))
    ),
    getByAltText: (text, options = {}) => createLocator(
      scopedSelector(selector, textSelector("alt", text, options))
    ),
    getByTitle: (text, options = {}) => createLocator(
      scopedSelector(selector, textSelector("title", text, options))
    ),
    getByTestId: (testId) => createLocator(scopedSelector(selector, testIdSelector(testId))),
    filter: (options = {}) => createLocator(filterSelector(selector, options)),
    click: (options = {}) => pointer.click(selector, options),
    dblclick: (options = {}) => pointer.dblclick(selector, options),
    hover: (options = {}) => pointer.hover(selector, options),
    dragTo: (target, options = {}) => pointer.drag([selector, target?.selector || target], options),
    scrollIntoViewIfNeeded: () => pointer.scrollIntoViewIfNeeded(selector),
    focus: () => keyboard.focus(selector),
    fill: (value, options = {}) => keyboard.fill(selector, value, options),
    clear: (options = {}) => keyboard.fill(selector, "", options),
    press: (key, options = {}) => keyboard.pressOnSelector(selector, key, options),
    pressSequentially: (text, options = {}) => keyboard.pressSequentially(selector, text, options),
    check: () => keyboard.check(selector),
    uncheck: () => keyboard.uncheck(selector),
    setChecked: (checked) => keyboard.setChecked(selector, checked),
    selectOption: (values) => keyboard.selectOption(selector, values),
    setInputFiles: (filesValue) => files.setInputFiles(selector, filesValue),
    dispatchEvent: (type, eventInit = {}) => keyboard.dispatchEvent(selector, type, eventInit),
    blur: () => locator.blur(selector),
    textContent: () => locator.textContent(selector),
    innerText: () => locator.innerText(selector),
    innerHTML: () => locator.innerHTML(selector),
    inputValue: () => locator.inputValue(selector),
    isChecked: () => locator.isChecked(selector),
    isVisible: () => locator.isVisible(selector),
    isHidden: () => locator.isHidden(selector),
    isEnabled: () => locator.isEnabled(selector),
    isDisabled: () => locator.isDisabled(selector),
    isEditable: () => locator.isEditable(selector),
    getAttribute: (name) => locator.getAttribute(selector, name),
    boundingBox: () => locator.boundingBox(selector),
    screenshot: async (options = {}) => {
      return withScopedReferenceAction(selector, options.timeout, async () => {
        const scoped = currentScopedReferenceAction();
        if (scoped && scoped.kind !== "group") {
          return observe.scopedElementScreenshot(scoped.binding, scoped.rootSessionId, options);
        }
        const box = await locator.boundingBox(selector);
        if (!box) {
          throw new Error(
            `locator.screenshot target has no bounding box: ${selector}`
          );
        }
        return observe.screenshot({ ...options, clip: box });
      });
    },
    count: () => locator.count(selector),
    allInnerTexts: () => locator.allInnerTexts(selector),
    allTextContents: () => locator.allTextContents(selector),
    evaluate: (pageFunction, arg = void 0) => locator.evaluateLocator(selector, pageFunction, arg),
    evaluateAll: (pageFunction, arg = void 0) => locator.evaluateAll(selector, pageFunction, arg),
    waitFor: (options = {}) => waits.waitForSelector(selector, options)
  };
}
function nthSelector(selector, index) {
  return `internal:nth=${index};${selector}`;
}
function internalSelector(kind, data) {
  return `internal:${kind}:${encodeURIComponent(JSON.stringify(data))}`;
}
function scopedSelector(base, child) {
  return internalSelector("scope", { base, child });
}
function locatorSelector(value) {
  if (value && typeof value === "object" && typeof value.selector === "string") {
    return value.selector;
  }
  return String(value);
}
function textSelector(prefix, text, options = {}) {
  const value = `${options.exact ? "exact:" : ""}${JSON.stringify(String(text))}`;
  return `loc=${prefix}:${value}`;
}
function roleSelector(role, options = {}) {
  const name = options && Object.prototype.hasOwnProperty.call(options, "name") ? `[name=${JSON.stringify(roleNameMatcher(options.name))}]` : "";
  return `loc=role:${role}${name}`;
}
function testIdSelector(testId) {
  return textSelector("testid", testId, { exact: true });
}
function filterSelector(base, options = {}) {
  const data = { base };
  if (Object.prototype.hasOwnProperty.call(options, "hasText")) {
    data.hasText = textMatcher(options.hasText);
  }
  if (Object.prototype.hasOwnProperty.call(options, "hasNotText")) {
    data.hasNotText = textMatcher(options.hasNotText);
  }
  if (options.has !== void 0) {
    data.has = locatorSelector(options.has);
  }
  if (options.hasNot !== void 0) {
    data.hasNot = locatorSelector(options.hasNot);
  }
  return internalSelector("filter", data);
}
function textMatcher(value) {
  if (value instanceof RegExp) {
    return { regex: value.source, flags: value.flags };
  }
  return { text: String(value), exact: false };
}
function roleNameMatcher(value) {
  if (value instanceof RegExp) {
    return { regex: value.source, flags: value.flags };
  }
  return value;
}
function createPageFacade() {
  return {
    setDefaultTimeout: (timeout) => {
      const value = Number(timeout);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          "page.setDefaultTimeout requires a non-negative number"
        );
      }
      state.defaultTimeout = value;
    },
    goto: nav.goto,
    goBack: nav.goBack,
    goForward: nav.goForward,
    reload: async (options = {}) => {
      const timeout = options.timeout ?? 15e3;
      if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError("page.reload timeout must be non-negative and finite");
      const deadline = state.now() + timeout;
      const immediateCheck = timeout === 0;
      const sessionId = await ensureSession();
      const expectedTargetId = pageIdForSessionAlias(sessionId);
      if (!expectedTargetId) {
        throw Object.assign(new Error("Reload page session is unavailable"), { error_code: "EGO_FRAME_UNAVAILABLE" });
      }
      if (!immediateCheck && state.now() >= deadline) return false;
      const response = await browserCdp("Page.getFrameTree", {}, sessionId,
        immediateCheck ? void 0 : Math.max(1, deadline - state.now()));
      const tree = state.cdpOverride ? response : response.result || {};
      const frame = tree.frameTree?.frame;
      const previousLoaderId = typeof frame?.loaderId === "string" && frame.loaderId ? frame.loaderId : void 0;
      const previousFrameId = typeof frame?.id === "string" && frame.id ? frame.id : void 0;
      if (!previousLoaderId && !previousFrameId) {
        throw Object.assign(new Error("Reload document identity is unavailable"), { error_code: "EGO_FRAME_UNAVAILABLE" });
      }
      if (pageIdForSessionAlias(sessionId) !== expectedTargetId) {
        throw Object.assign(new Error("Reload page scope changed before dispatch"), { error_code: "EGO_ACTION_SCOPE_MISMATCH" });
      }
      if (!immediateCheck && state.now() >= deadline) return false;
      await browserCdp("Page.reload", { ignoreCache: Boolean(options.ignoreCache) }, sessionId,
        immediateCheck ? void 0 : Math.max(1, deadline - state.now()));
      const loaded = await waitForDocumentLoad({
        timeout, deadline, expectedTargetId, previousLoaderId, previousFrameId,
        until: options.waitUntil === "commit" ? "commit" : options.waitUntil === "domcontentloaded" ? "domcontentloaded" : "load"
      });
      if (options.waitUntil === "commit") return false;
      if (!loaded || options.waitUntil !== "networkidle") return loaded;
      return waits.waitForLoadState("networkidle", {
        timeout: immediateCheck ? 0 : Math.max(0, deadline - state.now())
      });
    },
    info: nav.pageInfo,
    url: async () => (await nav.pageInfo()).url,
    title: async () => (await nav.pageInfo()).title,
    locator: createLocator,
    getByRole: (role, options = {}) => {
      return createLocator(roleSelector(role, options));
    },
    getByText: (text, options = {}) => createLocator(textSelector("text", text, options)),
    getByLabel: (text, options = {}) => createLocator(textSelector("label", text, options)),
    getByPlaceholder: (text, options = {}) => createLocator(textSelector("placeholder", text, options)),
    getByAltText: (text, options = {}) => createLocator(textSelector("alt", text, options)),
    getByTitle: (text, options = {}) => createLocator(textSelector("title", text, options)),
    getByTestId: (testId) => createLocator(testIdSelector(testId)),
    waitForTimeout: waits.waitForTimeout,
    waitForLoadState: waits.waitForLoadState,
    waitForSelector: waits.waitForSelector,
    waitForFunction: waits.waitForFunction,
    waitForURL: waits.waitForURL,
    waitForRequest: waits.waitForRequest,
    waitForResponse: waits.waitForResponse,
    waitForEvent: downloads.waitForEvent,
    evaluate,
    screenshot: observe.screenshot,
    snapshot: observe.snapshot,
    snapshotRaw: observe.snapshotRaw,
    elementCenter: observe.elementCenter,
    drainEvents: observe.drainEvents,
    dialogInfo: observe.dialogInfo,
    handleDialog: observe.handleDialog,
    keyboard: {
      press: keyboard.press,
      down: keyboard.down,
      up: keyboard.up,
      insertText: keyboard.insertText,
      type: keyboard.typeText
    },
    mouse: {
      click: (x, y, options = {}) => {
        const [target, effectiveOptions] = mousePointArgs(x, y, options);
        return pointer.click(target, effectiveOptions);
      },
      dblclick: (x, y, options = {}) => {
        const [target, effectiveOptions] = mousePointArgs(x, y, options);
        return pointer.dblclick(target, effectiveOptions);
      },
      move: (x, y) => pointer.hover([x, y]),
      down: pointer.down,
      up: pointer.up,
      wheel: pointer.wheel,
      drag: pointer.drag
    }
  };
}
function mousePointArgs(x, y, options) {
  if (Array.isArray(x) || x && typeof x === "object") {
    return [x, y || {}];
  }
  return [[x, y], options || {}];
}
function createBrowserFacade() {
  return {
    listTabs: nav.listTabs,
    currentTab: nav.currentTab,
    switchTab: nav.switchTab,
    openOrReuseTab: nav.openOrReuseTab,
    closeTab: nav.closeTab,
    ensureRealTab: nav.ensureRealTab,
    iframeTarget: nav.iframeTarget
  };
}
function createTaskSpacesFacade() {
  return {
    list: listTaskSpaces,
    switch: switchTaskSpace,
    new: newTaskSpace,
    useOrCreate: useOrCreateTaskSpace,
    claim: claimTaskSpace,
    complete: completeTaskSpace,
    handOff: handOffTaskSpace,
    takeOver: takeOverTaskSpace,
    observe: observeTaskSpace,
    requestControl,
    returnControl,
    waitForAgentControl
  };
}
function createSiteFacade() {
  return {
    skills: siteSkills,
    skillsForUrl: siteSkillsForUrl,
    runTool: runSiteTool,
    runBrowserTool: runSiteBrowserTool,
    learnContext
  };
}
const FACADE_HELP = {
  page: 'page: Playwright-style page facade. page.url() asynchronously returns the current URL; always call await page.url() before using the string. Use page.goto(url), page.locator(selector), page.getByText(text), page.getByLabel(text), page.getByPlaceholder(text), page.getByTestId(testId), page.setDefaultTimeout(ms), page.waitForEvent("download"), page.waitForLoadState(state, options), page.waitForURL(url, options), page.waitForRequest(urlOrPredicate, options), page.waitForResponse(urlOrPredicate, options), page.evaluate(expression), page.screenshot(options), page.keyboard.press(key), page.keyboard.type(text), and page.mouse.click(x, y). waitForURL predicates receive URL objects and waitUntil defaults to load.',
  locator: "page.locator(selector): returns a strict, auto-waiting locator facade with locator(), getByRole(), getByText(), filter(), first(), nth(index), last(), click(), fill(value), clear(), press(key), check(), selectOption(value), textContent(), innerText(), innerHTML(), isVisible(), isEnabled(), getAttribute(name), screenshot(), count(), evaluate(fn, arg), evaluateAll(fn, arg), and waitFor(options). Narrow multiple matches; use first()/nth() only for confirmed legitimate duplicates.",
  browser: "browser: tab facade. Use browser.listTabs(), browser.currentTab(), browser.switchTab(target), browser.openOrReuseTab(url, options), and browser.closeTab(target). Treat targetId as short-lived: obtain and validate it in the current script; switchTab/closeTab refresh the tab list before acting.",
  taskSpaces: "taskSpaces: task-space facade. Use taskSpaces.useOrCreate(nameOrId), taskSpaces.claim(nameOrId), taskSpaces.switch(nameOrId), taskSpaces.complete(nameOrId, options), taskSpaces.handOff(nameOrId), and taskSpaces.takeOver(nameOrId). Read-only collaboration uses taskSpaces.observe(nameOrId, targetId?). Request a handoff with taskSpaces.requestControl(nameOrId); the user or current writer must approve it. The current writer can call taskSpaces.returnControl(nameOrId, requestId?) to transfer to a pending requester or release to the user. taskSpaces.waitForAgentControl(nameOrId, {timeout, signal}) waits for explicit authorization; timeout is in seconds and signal is an AbortSignal. Names must be unique; use an ID for legacy duplicate names.",
  site: "site: learned site-skill facade. Use site.skills(url), site.skillsForUrl(url), site.runTool(siteId, toolName, args), site.runBrowserTool(siteId, toolName, args), and site.learnContext(url).",
  fetch: "fetch: network facade. Use fetch.server(url, options) for Node-side fetch and fetch.browser(url, options) for browser-origin fetch."
};
function helperContext(extra = {}) {
  const all = {
    page: createPageFacade(),
    browser: createBrowserFacade(),
    taskSpaces: createTaskSpacesFacade(),
    site: createSiteFacade(),
    fetch: {
      server: serverFetch,
      browser: browserFetch
    },
    cdp,
    ...extra
  };
  return {
    ...all,
    help: (...names) => {
      if (names.length === 1 && FACADE_HELP[names[0]]) {
        return FACADE_HELP[names[0]];
      }
      if (names.length === 0) {
        return Object.values(FACADE_HELP).join("\n\n");
      }
      const result = helpRuntime(all, ...names);
      if (typeof result === "string") return result;
      if (Array.isArray(result)) return result.map(formatHelp).join("\n\n");
      return formatHelp(result);
    }
  };
}
async function loadAgentHelpers() {
  const path = join(state.agentWorkspace(), "agent_helpers.js");
  if (!existsSync(path)) {
    return {};
  }
  const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const out = {};
  for (const [name, value] of Object.entries(module)) {
    if (!name.startsWith("_")) {
      out[name] = value;
    }
  }
  return out;
}
const __testing = { setOverrides, decodeUnserializableJsValue };
export {
  INTERNAL_URL_PREFIXES,
  NAME,
  __testing,
  allInnerTexts,
  allTextContents,
  blur,
  boundingBox,
  browserFetch2 as browserFetch,
  cdp2 as cdp,
  check,
  claimTaskSpace,
  click,
  closeTab,
  completeTaskSpace,
  count,
  currentTab,
  dblclick,
  dispatchEvent,
  down,
  drag,
  drainEvents,
  dialogInfo,
  elementCenter,
  ensureRealTab,
  evaluate2 as evaluate,
  evaluateAll,
  evaluateLocator,
  fill,
  focus,
  getAttribute,
  goBack,
  goForward,
  goto,
  handOffTaskSpace,
  handleDialog,
  helperContext,
  hover,
  iframeTarget,
  innerHTML,
  innerText,
  inputValue,
  insertText,
  isChecked,
  isDisabled,
  isEditable,
  isEnabled,
  isHidden,
  isVisible,
  learnContext,
  listTabs,
  listTaskSpaces,
  loadAgentHelpers,
  newTaskSpace,
  openOrReuseTab,
  pageInfo,
  press,
  pressSequentially,
  runSiteBrowserTool,
  runSiteTool,
  screenshot,
  scrollIntoViewIfNeeded,
  selectOption,
  serverFetch2 as serverFetch,
  setChecked,
  setInputFiles,
  siteSkills,
  siteSkillsForUrl,
  snapshot,
  snapshotRaw,
  switchTab,
  switchTaskSpace,
  takeOverTaskSpace,
  textContent,
  uncheck,
  up,
  useOrCreateTaskSpace,
  waitForAgentControl,
  waitForFunction,
  waitForLoadState,
  waitForRequest,
  waitForResponse,
  waitForSelector,
  waitForTimeout,
  waitForURL,
  wheel
};
