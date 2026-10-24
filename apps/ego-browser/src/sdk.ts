import { installEgoSdk } from "../../../vendor/ego-browser/src/index.js";
import { createAutomationSdk, type AutomationResult, type AutomationSession } from "./automation.ts";

export async function installPublicEgoSdk(
  runtime: Record<string, unknown>,
  target: Record<string, unknown> = globalThis,
  options: {
    recordOperation?: AutomationSession["recordOperation"];
    onAutomationResult?: (result: AutomationResult) => void;
  } = {},
): Promise<void> {
  installWebUiController(runtime);
  target.ego = runtime;
  installEgoSdk(target, { cliLog: console.log.bind(console) });
  target.automation = createAutomationSdk({
    sdk: target as unknown as AutomationSession["sdk"],
    automationRequest: async (operation, input) => {
      if (typeof runtime.automationRequest !== "function") throw new Error("This backend does not support continuous automation");
      return runtime.automationRequest(operation, input);
    },
    recordOperation: options.recordOperation || (async () => {}),
  }, undefined, options.onAutomationResult);
}

function installWebUiController(runtime: Record<string, unknown>): void {
  if (runtime.controller && typeof runtime.controller === "object") return;
  const controller: Record<string, unknown> = {
    getAllTabs: bind(runtime, "getAllTabs"),
    getTabGroups: bind(runtime, "getTabGroups"),
    activateTab: bind(runtime, "activateTab"),
    closeTab: bind(runtime, "closeTab"),
    openUrlInNewTab: bind(runtime, "openUrlInNewTab"),
    getAIPageContent: bind(runtime, "getAIPageContent"),
    saveTextToCollections: bind(runtime, "saveTextToCollections"),
    listCollections: bind(runtime, "listCollections"),
    sendMessage: bind(runtime, "sendCDPMessage"),
  };
  Object.defineProperty(controller, "onCDPMessage", {
    enumerable: true,
    get: () => runtime.onCDPMessage,
    set: (callback) => {
      runtime.onCDPMessage = callback;
    },
  });
  Object.defineProperty(controller, "onActiveTabChanged", {
    enumerable: true,
    get: () => runtime.onActiveTabChanged,
    set: (callback) => {
      runtime.onActiveTabChanged = callback;
    },
  });
  Object.defineProperty(controller, "onTextSelectionChanged", {
    enumerable: true,
    get: () => runtime.onTextSelectionChanged,
    set: (callback) => {
      runtime.onTextSelectionChanged = callback;
    },
  });
  runtime.controller = controller;
}

function bind(runtime: Record<string, unknown>, method: string) {
  const value = runtime[method];
  return typeof value === "function" ? value.bind(runtime) : undefined;
}
