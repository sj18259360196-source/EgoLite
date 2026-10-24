import { cdp, runtimeValue } from "../cdp-eval.js";
import {
  ElementResolutionError,
  queryRoleLocatorBackendNodeIds
} from "../element-resolver.js";
import { queryAllExpression as buildQueryAllExpression } from "../locator-query.js";
import { parseRef } from "../ref-map.js";
import { state } from "../state.js";
import {
  currentScopedReferenceAction,
  withScopedReferenceAction
} from "../scoped-reference-context.js";
import { releaseHandle, resolveAndCall, resolveHandle } from "./element-ops.js";
async function textContent(selector) {
  return readElement(selector, "function(){return this.textContent;}");
}
async function innerText(selector) {
  return readElement(
    selector,
    `function(){
      if (!(this instanceof HTMLElement)) throw new Error("innerText target must be an HTMLElement");
      return this.innerText;
    }`
  );
}
async function innerHTML(selector) {
  return readElement(
    selector,
    `function(){
      if (!(this instanceof Element)) throw new Error("innerHTML target must be an Element");
      return this.innerHTML;
    }`
  );
}
async function inputValue(selector) {
  return readElement(
    selector,
    `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return target.value;
      }
      throw new Error("inputValue target must be an input, textarea, or select");
    }`
  );
}
async function isChecked(selector) {
  return readElement(
    selector,
    `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (!(target instanceof HTMLInputElement) || (target.type !== "checkbox" && target.type !== "radio")) {
        throw new Error("isChecked target must be a checkbox or radio input");
      }
      return target.checked;
    }`
  );
}
async function isVisible(selector) {
  return readOptionalElement(
    selector,
    `function(){
      if (!(this instanceof Element)) return false;
      if (typeof this.checkVisibility === "function") {
        return this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const style = getComputedStyle(this);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = this.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }`,
    [],
    false
  );
}
async function isHidden(selector) {
  return !await isVisible(selector);
}
async function isEnabled(selector) {
  return readOptionalElement(
    selector,
    `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (!(target instanceof Element)) return false;
      if (target.getAttribute("aria-disabled") === "true") return false;
      if ("disabled" in target && target.disabled) return false;
      const disabledFieldset = target.closest("fieldset[disabled]");
      return !disabledFieldset;
    }`,
    [],
    false
  );
}
async function isDisabled(selector) {
  return !await isEnabled(selector);
}
async function isEditable(selector) {
  return readOptionalElement(
    selector,
    `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (!(target instanceof Element)) return false;
      if (target.isContentEditable) return true;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return !target.disabled && !target.readOnly;
      }
      return false;
    }`,
    [],
    false
  );
}
async function getAttribute(selector, name) {
  return readElement(
    selector,
    "function(name){return this.getAttribute(String(name));}",
    [name]
  );
}
async function blur(selector) {
  await readElement(selector, "function(){this.blur();}");
}
async function boundingBox(selector) {
  return readElement(
    selector,
    `function(){
      if (!(this instanceof Element)) return null;
      const rect = this.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }`
  );
}
async function count(selector) {
  if (parseRef(selector)) {
    return withScopedReferenceAction(selector, state.defaultTimeout, async () => {
      const handle = await resolveHandle(selector);
      await releaseHandle(handle.objectId, handle.sessionId);
      return 1;
    });
  }
  const backendNodeIds = await queryRoleBackendNodeIds(selector);
  if (backendNodeIds !== null) {
    return backendNodeIds.length;
  }
  return readQueryAll(selector, "return elements.length;");
}
async function allInnerTexts(selector) {
  if (parseRef(selector)) return [await innerText(selector)];
  return readQueryAll(
    selector,
    `return elements.map((element) => {
      if (!(element instanceof HTMLElement)) throw new Error("allInnerTexts targets must be HTMLElements");
      return element.innerText;
    });`
  );
}
async function allTextContents(selector) {
  if (parseRef(selector)) return [await textContent(selector)];
  return readQueryAll(
    selector,
    "return elements.map((element) => element.textContent);"
  );
}
async function evaluateLocator(selector, pageFunction, arg = void 0) {
  const functionSource = pageFunctionSource(pageFunction, "locator.evaluate");
  return withScopedReferenceAction(selector, state.defaultTimeout, async () => {
    try {
      return await readElement(
        selector,
        `function(functionSource, arg){
          const pageFunction = (0, eval)("(" + functionSource + ")");
          return pageFunction(this, arg);
        }`,
        [functionSource, arg]
      );
    } catch (error) {
      throw scopedEvaluationError(error);
    }
  });
}
async function evaluateAll(selector, pageFunction, arg = void 0) {
  const functionSource = pageFunctionSource(pageFunction, "evaluateAll");
  if (parseRef(selector)) {
    return withScopedReferenceAction(selector, state.defaultTimeout, async () => {
      try {
        return await readElement(
          selector,
          `function(functionSource, arg){
            const pageFunction = (0, eval)("(" + functionSource + ")");
            return pageFunction([this], arg);
          }`,
          [functionSource, arg]
        );
      } catch (error) {
        throw scopedEvaluationError(error);
      }
    });
  }
  const backendNodeIds = await queryRoleBackendNodeIds(selector);
  if (backendNodeIds !== null) {
    return evaluateRoleBackendNodes(backendNodeIds, functionSource, arg, true);
  }
  return evaluateQueryAll(selector, functionSource, arg);
}
function scopedEvaluationError(error) {
  if (!currentScopedReferenceAction() || error?.error_code) return error;
  if (!/^JavaScript evaluation failed/.test(error instanceof Error ? error.message : String(error ?? ""))) return error;
  return Object.assign(new Error("Scoped locator evaluation may have changed the page before JavaScript threw"), {
    error_code: "EGO_ACTION_RESULT_UNKNOWN",
    cause: error
  });
}
async function readElement(selector, functionDeclaration, args = []) {
  return withScopedReferenceAction(selector, state.defaultTimeout, () => (
    readElementWithRetry(selector, functionDeclaration, args)
  ));
}
async function readElementWithRetry(selector, functionDeclaration, args = []) {
  const deadline = state.now() + state.defaultTimeout;
  while (true) {
    try {
      return await readElementOnce(selector, functionDeclaration, args);
    } catch (error) {
      if (!(error instanceof ElementResolutionError) || error.kind !== "transient" || state.now() >= deadline) {
        throw error;
      }
      await state.sleep(Math.min(100, deadline - state.now()));
    }
  }
}
async function readElementOnce(selector, functionDeclaration, args = []) {
  const { result } = await resolveAndCall(selector, functionDeclaration, args);
  return runtimeValue(result, functionDeclaration);
}
async function readOptionalElement(selector, functionDeclaration, args = [], fallback) {
  return withScopedReferenceAction(selector, state.defaultTimeout, async () => {
    try {
      return await readElementOnce(selector, functionDeclaration, args);
    } catch (error) {
      if (error instanceof ElementResolutionError && error.kind === "transient") {
        return fallback;
      }
      throw error;
    }
  });
}
async function readQueryAll(selector, body) {
  const backendNodeIds = await queryRoleBackendNodeIds(selector);
  if (backendNodeIds !== null) {
    return evaluateRoleBackendNodes(
      backendNodeIds,
      `function(elements){${body}}`,
      void 0,
      false
    );
  }
  const expression = `(() => {
    const elements = ${buildQueryAllExpression(selector)};
    ${body}
  })()`;
  const result = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  });
  return runtimeValue(result, expression);
}
async function evaluateRoleBackendNodes(backendNodeIds, functionSource, arg, awaitPromise) {
  if (backendNodeIds.length === 0) {
    const expression = `(() => {
      const pageFunction = (0, eval)(${JSON.stringify(`(${functionSource})`)});
      return pageFunction([], ${serializedArg(arg)});
    })()`;
    const result = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    return runtimeValue(result, expression);
  }
  const handles = [];
  try {
    for (const backendNodeId of backendNodeIds) {
      const result2 = await cdp("DOM.resolveNode", {
        backendNodeId,
        objectGroup: "ego-browser-role-collection"
      });
      const objectId = result2.object?.objectId;
      if (!objectId) {
        throw new ElementResolutionError(
          `No objectId for AX backend node ${backendNodeId}`,
          "permanent"
        );
      }
      handles.push({ objectId });
    }
    const [first, ...rest] = handles;
    const functionDeclaration = `function(...args) {
      const functionSource = args.at(-2);
      const arg = args.at(-1);
      const elements = [this, ...args.slice(0, -2)];
      const pageFunction = (0, eval)("(" + functionSource + ")");
      return pageFunction(elements, arg);
    }`;
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration,
      objectId: first.objectId,
      arguments: [
        ...rest.map(({ objectId }) => ({ objectId })),
        { value: functionSource },
        { value: arg }
      ],
      returnByValue: true,
      awaitPromise
    });
    return runtimeValue(result, functionDeclaration);
  } finally {
    for (const { objectId } of handles) {
      await releaseHandle(objectId, void 0);
    }
  }
}
function queryRoleBackendNodeIds(selector) {
  return queryRoleLocatorBackendNodeIds({ sendRaw: cdp }, void 0, selector);
}
async function evaluateQueryAll(selector, functionSource, arg) {
  const expression = `(() => {
    const elements = ${buildQueryAllExpression(selector)};
    const pageFunction = (0, eval)(${JSON.stringify(`(${functionSource})`)});
    return pageFunction(elements, ${serializedArg(arg)});
  })()`;
  const result = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return runtimeValue(result, expression);
}
function pageFunctionSource(pageFunction, helperName) {
  if (typeof pageFunction === "function") {
    return pageFunction.toString();
  }
  if (typeof pageFunction === "string") {
    return pageFunction;
  }
  throw new TypeError(
    `${helperName} expects a function or string pageFunction, got ${pageFunction === null ? "null" : typeof pageFunction}`
  );
}
function serializedArg(arg) {
  return arg === void 0 ? "undefined" : JSON.stringify(arg);
}
export {
  allInnerTexts,
  allTextContents,
  blur,
  boundingBox,
  count,
  evaluateAll,
  evaluateLocator,
  getAttribute,
  innerHTML,
  innerText,
  inputValue,
  isChecked,
  isDisabled,
  isEditable,
  isEnabled,
  isHidden,
  isVisible,
  textContent
};
