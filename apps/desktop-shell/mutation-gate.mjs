import { AsyncLocalStorage } from "node:async_hooks";

// The original lease follows async continuations; it is never replaced by the
// lease of a new writer after a handoff.
export class MutationGate {
  #context = new AsyncLocalStorage();
  constructor(validate, validateAsync = async () => {}) { this.validate = validate; this.validateAsync = validateAsync; }
  run(context, operation) { return this.#context.run(context, operation); }
  current() { return this.#context.getStore(); }
  assertMutationAllowed(taskId) {
    const context = this.current();
    if (context) this.validate(context, taskId);
  }
  guardTarget(target, taskId) {
    const context = this.current();
    if (!context) return target;
    const assert = () => this.validate(context, taskId);
    const validateAsync = this.validateAsync;
    const asynchronous = new Set(["sendCommand", "executeJavaScript", "executeJavaScriptInIsolatedWorld", "loadURL", "insertCSS", "removeInsertedCSS"]);
    // Electron's native objects contain non-configurable, read-only properties.
    // A separate facade permits guarded child objects without violating Proxy invariants.
    const wrap = (object, methods) => new Proxy(Object.create(Object.getPrototypeOf(object)), {
      get(_facade, key) {
        const source = object;
        const value = Reflect.get(source, key, source);
        if (typeof value !== "function") return value;
        return (...args) => {
          if (methods.has(key) && asynchronous.has(key)) {
            return validateAsync(context, taskId).then(() => { assert(); return value.apply(source, args); });
          }
          if (methods.has(key)) assert();
          return value.apply(source, args);
        };
      },
      has: (_facade, key) => key in object,
      ownKeys: () => Reflect.ownKeys(object),
      getOwnPropertyDescriptor: (_facade, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
    const debuggerApi = wrap(target.debugger, new Set(["sendCommand", "attach", "detach"]));
    const history = target.navigationHistory && wrap(target.navigationHistory, new Set(["goBack", "goForward", "goToIndex", "goToOffset"]));
    const guarded = wrap(target, new Set(["executeJavaScript", "executeJavaScriptInIsolatedWorld", "sendInputEvent", "insertText", "loadURL", "reload", "reloadIgnoringCache", "close", "destroy", "focus", "insertCSS", "removeInsertedCSS", "setAudioMuted"]));
    return new Proxy(guarded, {
      get(source, key) {
        if (key === "debugger") return debuggerApi;
        if (key === "navigationHistory") return history;
        return Reflect.get(source, key);
      },
    });
  }
}
