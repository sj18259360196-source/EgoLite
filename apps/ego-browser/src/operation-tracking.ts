import { randomUUID } from "node:crypto";

interface OperationRecord {
  id: string;
  tool: string;
  title: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
}

interface OperationDescriptor {
  tool: string;
  title: string;
  detail?: string;
}

interface ProxyContext {
  target?: string;
}

type OperationRecorder = (record: OperationRecord) => Promise<unknown>;

const FACTORY_METHODS = new Set([
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
  "filter",
]);

const METHOD_OPERATIONS: Record<string, { tool: string; title: string }> = {
  "taskSpaces.list": { tool: "ego_status", title: "读取任务空间列表" },
  "taskSpaces.switch": { tool: "ego_task_use", title: "选择任务空间" },
  "taskSpaces.new": { tool: "ego_task_use", title: "创建任务空间" },
  "taskSpaces.useOrCreate": { tool: "ego_task_use", title: "选择任务空间" },
  "taskSpaces.claim": { tool: "ego_task_use", title: "接管任务空间" },
  "taskSpaces.takeOver": { tool: "ego_task_use", title: "恢复 Agent 控制" },
  "taskSpaces.waitForAgentControl": { tool: "ego_wait", title: "等待 Agent 控制" },
  "browser.listTabs": { tool: "ego_tabs", title: "读取标签页列表" },
  "browser.currentTab": { tool: "ego_tabs", title: "读取当前标签页" },
  "browser.switchTab": { tool: "ego_tab_select", title: "切换标签页" },
  "browser.openOrReuseTab": { tool: "ego_open", title: "打开网页" },
  "browser.closeTab": { tool: "ego_tab_close", title: "关闭标签页" },
  "browser.ensureRealTab": { tool: "ego_tabs", title: "检查可用标签页" },
  "browser.iframeTarget": { tool: "ego_inspect", title: "检查页面框架" },
  "page.goto": { tool: "ego_open", title: "打开网页" },
  "page.goBack": { tool: "ego_navigate", title: "执行页面导航：后退" },
  "page.goForward": { tool: "ego_navigate", title: "执行页面导航：前进" },
  "page.reload": { tool: "ego_navigate", title: "执行页面导航：刷新" },
  "page.info": { tool: "ego_page_info", title: "读取页面信息" },
  "page.url": { tool: "ego_page_info", title: "读取页面地址" },
  "page.title": { tool: "ego_page_info", title: "读取页面标题" },
  "page.snapshot": { tool: "ego_snapshot", title: "读取页面结构" },
  "page.snapshotRaw": { tool: "ego_snapshot", title: "读取页面结构" },
  "page.screenshot": { tool: "ego_screenshot", title: "截取页面画面" },
  "page.evaluate": { tool: "ego_evaluate", title: "执行页面脚本" },
  "page.dialogInfo": { tool: "ego_dialog_status", title: "检查网页对话框" },
  "page.handleDialog": { tool: "ego_dialog_respond", title: "处理网页对话框" },
  "page.waitForTimeout": { tool: "ego_wait", title: "等待页面加载" },
  "page.waitForLoadState": { tool: "ego_wait", title: "等待页面加载" },
  "page.waitForSelector": { tool: "ego_wait_for", title: "等待页面条件" },
  "page.waitForFunction": { tool: "ego_wait_for", title: "等待页面条件" },
  "page.waitForURL": { tool: "ego_wait_for", title: "等待页面地址" },
  "page.waitForRequest": { tool: "ego_wait_for", title: "等待网络请求" },
  "page.waitForResponse": { tool: "ego_wait_for", title: "等待网络响应" },
  "page.waitForEvent": { tool: "ego_wait_for", title: "等待页面事件" },
  "page.elementCenter": { tool: "ego_inspect", title: "检查页面元素" },
  "page.drainEvents": { tool: "ego_inspect", title: "读取页面事件" },
  "page.keyboard.press": { tool: "ego_press", title: "发送键盘按键" },
  "page.keyboard.down": { tool: "ego_press", title: "按下键盘按键" },
  "page.keyboard.up": { tool: "ego_press", title: "释放键盘按键" },
  "page.keyboard.insertText": { tool: "ego_type", title: "向页面输入文字" },
  "page.keyboard.type": { tool: "ego_type", title: "向页面输入文字" },
  "page.mouse.click": { tool: "ego_click", title: "点击页面坐标" },
  "page.mouse.dblclick": { tool: "ego_double_click", title: "双击页面坐标" },
  "page.mouse.move": { tool: "ego_hover", title: "移动鼠标" },
  "page.mouse.down": { tool: "ego_click", title: "按下鼠标" },
  "page.mouse.up": { tool: "ego_click", title: "释放鼠标" },
  "page.mouse.wheel": { tool: "ego_scroll", title: "滚动页面" },
  "page.mouse.drag": { tool: "ego_drag", title: "拖动页面元素" },
  "fetch.browser": { tool: "ego_browser_fetch", title: "发起页面请求" },
  "site.runBrowserTool": { tool: "ego_webmcp_call", title: "调用网站工具" },
  cdp: { tool: "ego_cdp", title: "执行浏览器命令" },
};

const LOCATOR_OPERATIONS: Record<string, { tool: string; title: string }> = {
  click: { tool: "ego_click", title: "点击页面元素" },
  dblclick: { tool: "ego_double_click", title: "双击页面元素" },
  dragTo: { tool: "ego_drag", title: "拖动页面元素" },
  fill: { tool: "ego_fill", title: "填写页面字段" },
  clear: { tool: "ego_fill", title: "清空页面字段" },
  press: { tool: "ego_press", title: "发送键盘按键" },
  pressSequentially: { tool: "ego_type", title: "向页面输入文字" },
  check: { tool: "ego_check", title: "切换复选框" },
  uncheck: { tool: "ego_check", title: "切换复选框" },
  setChecked: { tool: "ego_check", title: "切换复选框" },
  selectOption: { tool: "ego_select", title: "选择下拉选项" },
  hover: { tool: "ego_hover", title: "悬停页面元素" },
  scrollIntoViewIfNeeded: { tool: "ego_scroll", title: "滚动到页面元素" },
  setInputFiles: { tool: "ego_upload", title: "上传文件" },
  screenshot: { tool: "ego_screenshot", title: "截取页面元素" },
  waitFor: { tool: "ego_wait_for", title: "等待页面条件" },
  textContent: { tool: "ego_inspect", title: "读取页面元素" },
  innerText: { tool: "ego_inspect", title: "读取页面元素" },
  innerHTML: { tool: "ego_inspect", title: "读取页面元素" },
  inputValue: { tool: "ego_inspect", title: "读取页面字段" },
  isChecked: { tool: "ego_inspect", title: "检查页面元素" },
  isVisible: { tool: "ego_inspect", title: "检查页面元素" },
  isHidden: { tool: "ego_inspect", title: "检查页面元素" },
  isEnabled: { tool: "ego_inspect", title: "检查页面元素" },
  isDisabled: { tool: "ego_inspect", title: "检查页面元素" },
  isEditable: { tool: "ego_inspect", title: "检查页面元素" },
  getAttribute: { tool: "ego_inspect", title: "读取页面元素属性" },
  count: { tool: "ego_inspect", title: "统计页面元素" },
  allInnerTexts: { tool: "ego_inspect", title: "读取页面元素" },
  allTextContents: { tool: "ego_inspect", title: "读取页面元素" },
  evaluate: { tool: "ego_evaluate", title: "执行元素脚本" },
  evaluateAll: { tool: "ego_evaluate", title: "执行元素脚本" },
};

export function installCliOperationTracking(
  target: Record<string, unknown>,
  record: OperationRecorder,
): void {
  const proxyCache = new WeakMap<object, Map<string, object>>();
  for (const root of ["page", "browser", "taskSpaces", "fetch", "site"] as const) {
    const value = target[root];
    if (isProxyable(value)) target[root] = wrap(value, root, {});
  }
  if (typeof target.cdp === "function") {
    target.cdp = wrapFunction(target, "cdp", target.cdp as (...args: unknown[]) => unknown, {});
  }

  function wrap(value: object, path: string, context: ProxyContext): object {
    let paths = proxyCache.get(value);
    if (!paths) {
      paths = new Map();
      proxyCache.set(value, paths);
    }
    const cacheKey = `${path}\u0000${context.target ?? ""}`;
    const cached = paths.get(cacheKey);
    if (cached) return cached;
    const proxy = new Proxy(value, {
      get(source, property, receiver) {
        const member = Reflect.get(source, property, receiver);
        if (typeof property !== "string") return member;
        const memberPath = `${path}.${property}`;
        if (typeof member === "function") return wrapFunction(source, memberPath, member, context);
        return isProxyable(member) ? wrap(member, memberPath, context) : member;
      },
    });
    paths.set(cacheKey, proxy);
    return proxy;
  }

  function wrapFunction(
    owner: object,
    path: string,
    fn: (...args: unknown[]) => unknown,
    context: ProxyContext,
  ) {
    return (...args: unknown[]) => {
      const descriptor = operationFor(path, args, context);
      const startedAt = descriptor ? new Date().toISOString() : "";
      const id = descriptor ? randomUUID() : "";
      const running = descriptor
        ? safeRecord({ id, ...descriptor, status: "running", startedAt })
        : Promise.resolve();
      let result: unknown;
      try {
        result = Reflect.apply(fn, owner, args);
      } catch (error) {
        if (descriptor) void running.then(() => safeRecord(failedRecord(id, descriptor, startedAt, error)));
        throw error;
      }
      const nextContext = factoryContext(path, args, context);
      if (!isPromiseLike(result)) return isProxyable(result) ? wrap(result, path, nextContext) : result;
      if (!descriptor) return result.then((value) => isProxyable(value) ? wrap(value, path, nextContext) : value);
      return (async () => {
        await running;
        try {
          const value = await result;
          await safeRecord({
            id,
            ...descriptor,
            status: "completed",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          return isProxyable(value) ? wrap(value, path, nextContext) : value;
        } catch (error) {
          await safeRecord(failedRecord(id, descriptor, startedAt, error));
          throw error;
        }
      })();
    };
  }

  async function safeRecord(operation: OperationRecord): Promise<void> {
    await Promise.resolve(record(operation)).catch(() => {});
  }
}

function operationFor(path: string, args: unknown[], context: ProxyContext): OperationDescriptor | undefined {
  const direct = METHOD_OPERATIONS[path];
  const method = path.split(".").at(-1) ?? "";
  const base = direct ?? (path.startsWith("page.") ? LOCATOR_OPERATIONS[method] : undefined);
  if (!base) return undefined;
  const title = operationTitle(path, args, base.title);
  const detail = operationDetail(path, method, args, context);
  return { ...base, title, ...(detail ? { detail } : {}) };
}

function operationTitle(path: string, args: unknown[], base: string): string {
  if (["page.goto", "browser.openOrReuseTab"].includes(path) && typeof args[0] === "string") {
    return `${base}：${shortText(args[0], 160)}`;
  }
  if (["taskSpaces.switch", "taskSpaces.new", "taskSpaces.useOrCreate", "taskSpaces.claim"].includes(path)) {
    if (["string", "number"].includes(typeof args[0])) return `${base}：${shortText(String(args[0]), 120)}`;
  }
  return base;
}

function operationDetail(
  path: string,
  method: string,
  args: unknown[],
  context: ProxyContext,
): string | undefined {
  const safe: Record<string, unknown> = {};
  if (context.target) safe.target = context.target;
  if (["page.goto", "browser.openOrReuseTab", "fetch.browser"].includes(path) && typeof args[0] === "string") {
    safe.url = shortText(args[0], 240);
  }
  if (["browser.switchTab", "browser.closeTab"].includes(path) && typeof args[0] === "string") {
    safe.target = shortText(args[0], 160);
  }
  if (["press", "down", "up"].includes(method) && typeof args[0] === "string") safe.key = shortText(args[0], 80);
  if (["fill", "pressSequentially", "insertText", "type", "evaluate", "evaluateAll"].includes(method)) {
    safe.content = "已隐藏";
  }
  if (method === "setInputFiles") safe.content = "已隐藏";
  if (["check", "uncheck", "setChecked"].includes(method)) safe.checked = method !== "uncheck";
  return Object.keys(safe).length ? JSON.stringify(safe) : undefined;
}

function factoryContext(path: string, args: unknown[], context: ProxyContext): ProxyContext {
  const method = path.split(".").at(-1) ?? "";
  if (!FACTORY_METHODS.has(method)) return context;
  if (["locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId"].includes(method)) {
    const target = typeof args[0] === "string" ? shortText(args[0], 160) : undefined;
    return target ? { target } : context;
  }
  return context;
}

function failedRecord(
  id: string,
  descriptor: OperationDescriptor,
  startedAt: string,
  error: unknown,
): OperationRecord {
  const message = error instanceof Error ? error.message : String(error || "");
  let detail: Record<string, unknown> = {};
  try {
    detail = descriptor.detail ? JSON.parse(descriptor.detail) as Record<string, unknown> : {};
  } catch {
    detail = descriptor.detail ? { detail: descriptor.detail } : {};
  }
  return {
    id,
    ...descriptor,
    detail: JSON.stringify({ ...detail, ...(message ? { error: shortText(message, 1_000) } : {}) }),
    status: "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function");
}

function isProxyable(value: unknown): value is object {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp));
}

function shortText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
