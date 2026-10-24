import { AsyncLocalStorage } from "node:async_hooks";

import {
  ensureSession,
  browserEgo,
  registerPageSessionAlias
} from "./browser-runtime.js";
import { parseRef } from "./ref-map.js";
import { browserRefMap, ensureRefMapForRef } from "./ref-state.js";
import { state } from "./state.js";

const ACTION_EXECUTION_ALLOWANCE_MS = 30e3;
const storage = new AsyncLocalStorage();

async function withScopedReferenceAction(selectorOrRef, timeout, operation, options = {}) {
  const refId = parseRef(selectorOrRef);
  if (!refId) return operation();
  const current = storage.getStore();
  if (current) {
    if (!contextContainsRef(current, refId)) throw actionContextInvalid("A scoped action cannot switch refs while it is running");
    return operation();
  }
  await ensureRefMapForRef(selectorOrRef);
  const entry = browserRefMap.get(refId);
  if (!entry) {
    if (browserRefMap.isScopedMode()) throw staleReference(refId);
    return operation();
  }
  if (entry.refFormat !== "scoped-v1") return operation();

  const runtime = browserEgo();
  if (typeof runtime.bindReferenceAction !== "function" || typeof runtime.releaseReferenceAction !== "function") {
    throw actionContextInvalid("Scoped reference actions are unavailable in this runtime");
  }
  const requestedLifetimeMs = referenceActionLifetime(runtime, timeout, options.additionalExecutionMs);
  const rootSessionId = await ensureSession();
  const pageId = state.sessionTargetId;
  if (!pageId) throw actionScopeMismatch("The selected page is unavailable");
  registerPageSessionAlias(rootSessionId, pageId);
  const binding = await runtime.bindReferenceAction({
    ref: { refId: Number(refId), runtimeId: entry.runtimeId },
    expectedScope: { pageId },
    deadlineAt: state.now() + requestedLifetimeMs
  });
  const wire = binding?.version === "scoped-v1" && typeof binding.token === "string" && binding.token
    && typeof binding.runtimeId === "string" && binding.runtimeId
    ? { version: "scoped-v1", runtimeId: binding.runtimeId, token: binding.token }
    : null;
  const context = {
    refId,
    binding,
    wire,
    rootSessionId
  };
  try {
    validateBinding(binding, entry.runtimeId, pageId);
    if (binding.sessionId) registerPageSessionAlias(binding.sessionId, pageId);
    return await storage.run(context, operation);
  } finally {
    if (wire) {
      await runtime.releaseReferenceAction(wire).catch(() => {
      });
    }
  }
}

async function withScopedReferenceGroup(source, target, timeout, operation) {
  const sourceRefId = parseRef(source);
  const targetRefId = parseRef(target);
  const current = storage.getStore();
  if (current) {
    if (sourceRefId && targetRefId && contextContainsRef(current, sourceRefId) && contextContainsRef(current, targetRefId)) {
      return operation();
    }
    throw actionContextInvalid("A scoped drag cannot change its bound reference group");
  }
  if (sourceRefId) await ensureRefMapForRef(source);
  if (targetRefId) await ensureRefMapForRef(target);
  const sourceEntry = sourceRefId ? browserRefMap.get(sourceRefId) : null;
  const targetEntry = targetRefId ? browserRefMap.get(targetRefId) : null;
  const sourceScoped = sourceEntry?.refFormat === "scoped-v1";
  const targetScoped = targetEntry?.refFormat === "scoped-v1";
  if (!sourceScoped && !targetScoped) return operation();
  if (!sourceScoped || !targetScoped || !sourceRefId || !targetRefId) {
    throw actionScopeMismatch("Scoped drag requires both source and target to be scoped refs");
  }
  if (sourceEntry.runtimeId !== targetEntry.runtimeId) {
    throw actionScopeMismatch("Scoped drag refs belong to different runtimes");
  }
  if (sourceEntry.pageId && targetEntry.pageId && sourceEntry.pageId !== targetEntry.pageId) {
    throw actionScopeMismatch("Scoped drag refs belong to different pages");
  }

  const runtime = browserEgo();
  if (typeof runtime.bindReferenceActionGroup !== "function" || typeof runtime.releaseReferenceAction !== "function") {
    throw actionContextInvalid("Scoped drag actions are unavailable in this runtime");
  }
  const requestedLifetimeMs = referenceActionLifetime(runtime, timeout, 0);
  const rootSessionId = await ensureSession();
  const pageId = state.sessionTargetId;
  if (!pageId) throw actionScopeMismatch("The selected page is unavailable");
  registerPageSessionAlias(rootSessionId, pageId);
  const binding = await runtime.bindReferenceActionGroup({
    kind: "drag",
    source: { refId: Number(sourceRefId), runtimeId: sourceEntry.runtimeId },
    target: { refId: Number(targetRefId), runtimeId: targetEntry.runtimeId },
    expectedScope: { pageId },
    deadlineAt: state.now() + requestedLifetimeMs
  });
  const wire = actionWire(binding);
  try {
    validateGroupBinding(binding, sourceRefId, targetRefId, sourceEntry.runtimeId, pageId);
    if (binding.sessionId) registerPageSessionAlias(binding.sessionId, pageId);
    const common = {
      version: binding.version,
      token: binding.token,
      expiresAt: binding.expiresAt,
      runtimeId: binding.runtimeId,
      pageId: binding.pageId,
      frameId: binding.frameId,
      documentId: binding.documentId,
      documentEpoch: binding.documentEpoch,
      sessionId: binding.sessionId
    };
    const bindings = /* @__PURE__ */ new Map([
      [sourceRefId, { ...common, backendNodeId: binding.source.backendNodeId }],
      [targetRefId, { ...common, backendNodeId: binding.target.backendNodeId }]
    ]);
    const context = { kind: "group", binding, bindings, wire, rootSessionId };
    return await storage.run(context, operation);
  } finally {
    if (wire) await runtime.releaseReferenceAction(wire).catch(() => {
    });
  }
}

function currentScopedReferenceAction() {
  return storage.getStore();
}

function scopedBindingForRef(refId, entry) {
  if (entry?.refFormat !== "scoped-v1") return null;
  const current = storage.getStore();
  const binding = current?.kind === "group" ? current.bindings.get(refId) : current?.binding;
  if (!current || !contextContainsRef(current, refId) || binding?.runtimeId !== entry.runtimeId) {
    throw actionContextInvalid("Scoped ref resolution requires its bound action context");
  }
  return binding;
}

function contextContainsRef(context, refId) {
  return context?.kind === "group" ? context.bindings.has(refId) : context?.refId === refId;
}

function referenceActionLifetime(runtime, timeout, additionalExecution = 0) {
  const waitTimeout = Number(timeout ?? state.defaultTimeout);
  if (!Number.isFinite(waitTimeout)) {
    throw actionContextInvalid("Scoped reference action timeout must be finite");
  }
  const waitBudget = Math.max(0, waitTimeout);
  const additionalExecutionMs = Number(additionalExecution ?? 0);
  if (!Number.isFinite(additionalExecutionMs) || additionalExecutionMs < 0) {
    throw actionContextInvalid("Scoped reference action execution budget must be a finite non-negative number");
  }
  const requestedLifetimeMs = waitBudget + ACTION_EXECUTION_ALLOWANCE_MS + additionalExecutionMs;
  const knownMaxLifetimeMs = Number(runtime.getReferenceActionMaxLifetimeMs?.());
  if (Number.isFinite(knownMaxLifetimeMs) && knownMaxLifetimeMs > 0 && requestedLifetimeMs > knownMaxLifetimeMs) {
    throw Object.assign(
      actionContextInvalid(
        `Scoped reference action lifetime ${requestedLifetimeMs}ms exceeds negotiated maximum ${knownMaxLifetimeMs}ms`
      ),
      { requestedLifetimeMs, maxLifetimeMs: knownMaxLifetimeMs }
    );
  }
  return requestedLifetimeMs;
}

function actionWire(binding) {
  return binding?.version === "scoped-v1" && typeof binding.token === "string" && binding.token
    && typeof binding.runtimeId === "string" && binding.runtimeId
    ? { version: "scoped-v1", runtimeId: binding.runtimeId, token: binding.token }
    : null;
}

function validateBinding(binding, runtimeId, pageId) {
  if (
    !binding
    || binding.version !== "scoped-v1"
    || typeof binding.token !== "string"
    || !binding.token
    || binding.runtimeId !== runtimeId
  ) {
    throw actionContextInvalid("Runtime returned an invalid scoped reference binding");
  }
  if (binding.pageId !== pageId) {
    throw actionScopeMismatch("Scoped reference belongs to a different page");
  }
  if (
    typeof binding.frameId !== "string"
    || typeof binding.documentId !== "string"
    || !Number.isSafeInteger(binding.documentEpoch)
    || !Number.isSafeInteger(binding.backendNodeId)
  ) {
    throw actionContextInvalid("Runtime returned incomplete scoped reference identity");
  }
}

function validateGroupBinding(binding, sourceRefId, targetRefId, runtimeId, pageId) {
  if (
    !binding
    || binding.kind !== "drag"
    || binding.version !== "scoped-v1"
    || typeof binding.token !== "string"
    || !binding.token
    || binding.runtimeId !== runtimeId
    || binding.pageId !== pageId
  ) {
    throw actionContextInvalid("Runtime returned an invalid scoped drag binding");
  }
  if (
    typeof binding.frameId !== "string"
    || typeof binding.documentId !== "string"
    || !Number.isSafeInteger(binding.documentEpoch)
    || binding.source?.refId !== Number(sourceRefId)
    || binding.target?.refId !== Number(targetRefId)
    || !Number.isSafeInteger(binding.source?.backendNodeId)
    || !Number.isSafeInteger(binding.target?.backendNodeId)
  ) {
    throw actionScopeMismatch("Scoped drag binding is not one exact frame and document");
  }
}

function staleReference(refId) {
  return Object.assign(new Error(`Stale scoped ref: ${refId}; take a new snapshot`), {
    error_code: "EGO_REFERENCE_STALE"
  });
}

function actionContextInvalid(message) {
  return Object.assign(new Error(message), { error_code: "EGO_ACTION_CONTEXT_INVALID" });
}

function actionScopeMismatch(message) {
  return Object.assign(new Error(message), { error_code: "EGO_ACTION_SCOPE_MISMATCH" });
}

export {
  currentScopedReferenceAction,
  scopedBindingForRef,
  withScopedReferenceAction,
  withScopedReferenceGroup
};
