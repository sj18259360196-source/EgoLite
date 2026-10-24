import { randomUUID } from "node:crypto";
import { DEFAULT_REFERENCE_ACTION_MAX_MS } from "./automation-capabilities.mjs";

import {
  normalizeSnapshotOptions,
  serializeSnapshotCandidates,
} from "./desktop-browser-controller.mjs";
import { bindReferencePair, assertReferencePairCurrent, releaseReferencePair, projectReferencePair } from "./desktop-reference-pair.mjs";

const DEFAULT_MAX_ACTION_TTL_MS = DEFAULT_REFERENCE_ACTION_MAX_MS;
const MUTATING_METHOD = /^(Input\.|Runtime\.(evaluate|callFunctionOn)|DOM\.(focus|setFileInputFiles|scrollIntoViewIfNeeded))/;

export class DesktopScopedAutomationError extends Error {
  constructor(code, message, data = {}, options) {
    super(message, options);
    this.name = "DesktopScopedAutomationError";
    this.code = code;
    this.data = Object.freeze({ ...data });
  }
}

export async function invokeAfterFinalAuthorization({ authorize, assertAllowed, invoke }) {
  if (typeof authorize !== "function" || typeof assertAllowed !== "function" || typeof invoke !== "function") {
    throw new TypeError("Final authorization requires authorize, assertAllowed, and invoke callbacks");
  }
  await authorize();
  assertAllowed();
  return invoke();
}

export function scopedCommandRequiresBoundFocus(method, params = {}) {
  return method === "Input.insertText"
    || (method === "Input.dispatchKeyEvent" && ["keyDown", "rawKeyDown", "char"].includes(params.type));
}

export function scopedCommandRequiresExactObject(method, params = {}) {
  return Boolean(params.objectId) && ["Runtime.callFunctionOn", "DOM.setFileInputFiles"].includes(method);
}

export class DesktopScopedAutomation {
  #router;
  #registry;
  #mutationGate;
  #captureRootCandidates;
  #captureFrameCandidates;
  #resolveRootFrameId;
  #validateBoundCommand;
  #sendFrameCommand;
  #resolveBoundObjectIdentity;
  #isPageSelected;
  #now;
  #schedule;
  #cancel;
  #maxQueuedPerPage;
  #maxAdmissionPages;
  #maxActionTtlMs;
  #admissionPages = new Map();
  #admissions = new Map();
  #bindings = new Map();
  #retiredGroupActions = new Map();
  #diagnose;
  #nextDiagnosticId = 1;

  constructor(options = {}) {
    for (const name of ["router", "registry", "mutationGate"]) {
      if (!options[name]) throw new TypeError(`DesktopScopedAutomation requires ${name}`);
    }
    for (const name of [
      "captureRootCandidates",
      "resolveRootFrameId",
      "validateBoundCommand",
      "sendFrameCommand",
    ]) {
      if (typeof options[name] !== "function") throw new TypeError(`DesktopScopedAutomation requires ${name}`);
    }
    this.#router = options.router;
    this.#diagnose = options.diagnose || (() => {});
    this.#registry = options.registry;
    this.#mutationGate = options.mutationGate;
    this.#captureRootCandidates = options.captureRootCandidates;
    this.#captureFrameCandidates = options.captureFrameCandidates || (async () => ({ candidates: [], totalCandidates: 0, complete: false }));
    this.#resolveRootFrameId = options.resolveRootFrameId;
    this.#validateBoundCommand = options.validateBoundCommand;
    this.#sendFrameCommand = options.sendFrameCommand;
    this.#resolveBoundObjectIdentity = options.resolveBoundObjectIdentity;
    this.#isPageSelected = options.isPageSelected || (() => true);
    if (typeof this.#isPageSelected !== "function") throw new TypeError("isPageSelected must be a function");
    this.#now = options.now || Date.now;
    this.#schedule = options.schedule || setTimeout;
    this.#cancel = options.cancel || clearTimeout;
    this.#maxQueuedPerPage = positiveSafeInteger(options.maxQueuedPerPage ?? 32, "maxQueuedPerPage");
    this.#maxAdmissionPages = positiveSafeInteger(options.maxAdmissionPages ?? 1_000, "maxAdmissionPages");
    this.#maxActionTtlMs = positiveSafeInteger(options.maxActionTtlMs ?? DEFAULT_MAX_ACTION_TTL_MS, "maxActionTtlMs");
  }

  async snapshot({ pageScope, clientId, options: requestedOptions } = {}) {
    const page = normalizePageScope(pageScope);
    nonEmptyString(clientId, "clientId");
    const options = normalizeSnapshotOptions(requestedOptions);
    const rootFrameId = this.#resolveRootFrameId(page);
    if (typeof rootFrameId !== "string" || !rootFrameId) {
      throw automationError("EGO_FRAME_UNAVAILABLE", "The root frame execution context is not ready", { retry: "resnapshot", delivery: "not_sent" });
    }
    const routes = this.#router.listFrameRoutes(page);
    const rootRoute = routes.find((route) => route.identity.frameId === rootFrameId);
    if (!rootRoute) throw mapAutomationError(Object.assign(new Error("Root frame route is unavailable"), { code: "FRAME_CONTEXT_UNAVAILABLE" }), "snapshot");
    const expectedFrames = this.#router.stats(page).frames;
    const incompleteFrames = [];
    const captures = [];
    const pendingTickets = new Set();
    let remaining = 600;
    let totalLines = 0;
    let title = "";
    let url = "";
    try {
      for (const route of routes) {
        let ticket;
        try {
          const stamp = await this.#router.captureFrameIdentity({ pageScope: page, frameId: route.identity.frameId });
          ticket = this.#registry.beginSnapshot(stamp.identity);
          pendingTickets.add(ticket);
          const captured = route.identity.frameId === rootFrameId
            ? await this.#captureRootCandidates({ pageScope: page, frameId: rootFrameId, route, stamp, options })
            : await this.#captureFrameCandidates({ pageScope: page, route, stamp, options, candidateLimit: remaining });
          await this.#router.validateFrameIdentity(stamp);
          if (!Array.isArray(captured?.candidates)) throw new TypeError("Frame snapshot candidates must be an array");
          const originalCount = Number.isSafeInteger(captured.totalCandidates)
            ? captured.totalCandidates
            : captured.candidates.length;
          totalLines += originalCount;
          const selected = captured.candidates.slice(0, remaining);
          remaining -= selected.length;
          const nodes = selected.map((candidate) => ({
            backendNodeId: positiveSafeInteger(candidate?.backendNodeId, "candidate.backendNodeId"),
          }));
          captures.push({
            ticket,
            stamp,
            nodes,
            complete: captured.complete !== false && selected.length === originalCount,
            candidates: selected.map((candidate) => {
              const { stableLocator: _childLocator, ...safeCandidate } = candidate;
              const exposed = route.identity.frameId === rootFrameId ? candidate : safeCandidate;
              return exposed;
            }),
          });
          if (route.identity.frameId === rootFrameId) {
            title = typeof captured.title === "string" ? captured.title : "";
            url = typeof captured.url === "string" ? captured.url : "";
          }
          if (captured.complete === false) incompleteFrames.push(route.identity.frameId);
        } catch (error) {
          if (route.identity.frameId === rootFrameId) throw error;
          incompleteFrames.push(route.identity.frameId);
        }
      }
      if (expectedFrames > routes.length) incompleteFrames.push("unresolved-frame");
      for (let index = captures.length - 1; index >= 0; index -= 1) {
        const capture = captures[index];
        try {
          await this.#router.validateFrameIdentity(capture.stamp);
        } catch (error) {
          if (capture.stamp.identity.frameId === rootFrameId) throw error;
          incompleteFrames.push(capture.stamp.identity.frameId);
          captures.splice(index, 1);
        }
      }
      // Complete all native awaits first, then inspect every stamp together.
      // An earlier validation can become stale while a later frame is queried.
      for (let index = captures.length - 1; index >= 0; index -= 1) {
        const capture = captures[index];
        try {
          if (!this.#router.isCurrentDocument(capture.stamp.identity)) {
            throw Object.assign(new Error("Frame document changed after capture"), { code: "STALE_DOCUMENT" });
          }
          const currentRoute = this.#router.listFrameRoutes(page).find((route) => route.identity.frameId === capture.stamp.identity.frameId);
          if (!currentRoute || currentRoute.nativeSessionGeneration !== capture.stamp.nativeSessionGeneration) {
            throw Object.assign(new Error("Frame transport changed after capture"), { code: "STALE_SESSION_ROUTE" });
          }
        } catch (error) {
          if (capture.stamp.identity.frameId === rootFrameId) throw error;
          incompleteFrames.push(capture.stamp.identity.frameId);
          captures.splice(index, 1);
        }
      }
      const finalRoutes = this.#router.listFrameRoutes(page);
      const initialFrameIds = new Set(routes.map((route) => route.identity.frameId));
      for (const route of finalRoutes) {
        if (!initialFrameIds.has(route.identity.frameId)) incompleteFrames.push(route.identity.frameId);
      }
      if (this.#router.stats(page).frames > finalRoutes.length) incompleteFrames.push("unresolved-frame");
      const preview = serializeSnapshotCandidates(
        captures.flatMap((capture) => capture.candidates.map((candidate) => ({ ...candidate, refId: Number.MAX_SAFE_INTEGER }))),
        options,
        { totalLines },
      );
      const fullDocument = options.scope === "full_page" && !preview.truncation && !incompleteFrames.length
        && captures.every((capture) => capture.complete) && captures.length === finalRoutes.length;
      // Keep the original ticket sequence; an older capture must never acquire
      // a newer ticket and erase references published by a concurrent capture.
      for (const capture of captures) {
        pendingTickets.delete(capture.ticket);
        const records = this.#registry.commitSnapshot(capture.ticket, {
          mode: fullDocument ? "full_document" : "partial",
          nodes: capture.nodes,
        });
        const recordsByNode = new Map(records.map((record) => [record.backendNodeId, record]));
        capture.candidates = capture.candidates.map((candidate) => Object.freeze({ ...candidate, ...recordsByNode.get(candidate.backendNodeId) }));
      }
      const candidates = captures.flatMap((capture) => capture.candidates);
      const serialized = serializeSnapshotCandidates(candidates, options, { totalLines });
      const rootStamp = captures.find((capture) => capture.stamp.identity.frameId === rootFrameId)?.stamp;
      return Object.freeze({
        title,
        url,
        ...serialized,
        refFormat: "scoped-v1",
        completeness: fullDocument ? "complete-page" : "partial",
        runtimeId: page.runtimeId,
        pageId: page.pageId,
        documentId: rootStamp.identity.documentId,
        documentEpoch: rootStamp.identity.documentEpoch,
        ...(incompleteFrames.length ? { incompleteFrames: [...new Set(incompleteFrames)] } : {}),
      });
    } catch (error) {
      throw mapAutomationError(error, "snapshot");
    } finally {
      for (const ticket of pendingTickets) {
        try { this.#registry.discardSnapshot(ticket); } catch {}
      }
    }
  }

  async bindReferenceAction({ pageScope, clientId, mutation, request } = {}) {
    const page = normalizePageScope(pageScope);
    const caller = nonEmptyString(clientId, "clientId");
    const lease = normalizeMutation(mutation, page.taskId, caller);
    const refId = positiveSafeInteger(request?.ref?.refId, "request.ref.refId");
    const runtimeId = nonEmptyString(request?.ref?.runtimeId, "request.ref.runtimeId");
    const expectedPageId = nonEmptyString(request?.expectedScope?.pageId, "request.expectedScope.pageId");
    if (runtimeId !== page.runtimeId || expectedPageId !== page.pageId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Reference runtime or page does not match the selected page");
    }
    const now = this.#now();
    const expiresAt = request?.deadlineAt === undefined
      ? now + this.#maxActionTtlMs
      : futureDeadlineWithinLimit(request.deadlineAt, now, this.#maxActionTtlMs);
    const admission = await this.#acquireAdmission(page, caller, expiresAt);
    let token;
    try {
      const result = await this.#mutationGate.run(lease, async () => {
        this.#mutationGate.assertMutationAllowed(page.taskId);
        const identity = this.#registry.resolve(refId, page);
        const route = this.#router.resolveFrameCommand({
          pageScope: page,
          frameId: identity.frameId,
          expectedIdentity: identity,
        });
        const attached = this.#router.attachClient({
          pageScope: page,
          clientId: caller,
          targetId: nonEmptyString(route.targetId, "route.targetId"),
        });
        token = await this.#registry.bindAction(refId, {
          expectedScope: fullExpectedScope(identity),
          lease,
          deadlineAt: expiresAt,
        });
        return { identity, route, attached };
      });
      if (this.#admissions.get(admission.id) !== admission || this.#now() >= expiresAt) {
        if (token) this.#registry.releaseBoundAction(token);
        throw automationError("EGO_ACTION_EXPIRED", "Action admission expired during binding");
      }
      const binding = Object.freeze({
        diagnosticId: this.#nextDiagnosticId++,
        token,
        version: "scoped-v1",
        pageScope: page,
        clientId: caller,
        lease,
        leaseKey: mutationKey(lease),
        identity: result.identity,
        sessionId: result.attached.alias,
        nativeSessionGeneration: result.route.nativeSessionGeneration,
        admissionId: admission.id,
        expiresAt,
      });
      admission.members.add(token);
      this.#bindings.set(token, binding);
      this.#trace(binding, "bound");
      return Object.freeze({
        version: "scoped-v1",
        token,
        expiresAt,
        runtimeId: result.identity.runtimeId,
        pageId: result.identity.pageId,
        frameId: result.identity.frameId,
        documentId: result.identity.documentId,
        documentEpoch: result.identity.documentEpoch,
        backendNodeId: result.identity.backendNodeId,
        ...(result.attached.alias ? { sessionId: result.attached.alias } : {}),
      });
    } catch (error) {
      if (token) this.#registry.releaseBoundAction(token);
      this.#releaseAdmission(admission);
      throw mapAutomationError(error, "bind");
    }
  }

  async bindReferenceActionGroup({ pageScope, clientId, mutation, request } = {}) {
    const page = normalizePageScope(pageScope);
    const caller = nonEmptyString(clientId, "clientId");
    const lease = normalizeMutation(mutation, page.taskId, caller);
    if (request?.kind !== "drag" || request?.expectedScope?.pageId !== page.pageId
      || request?.source?.runtimeId !== page.runtimeId || request?.target?.runtimeId !== page.runtimeId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Drag group does not match its trusted page scope");
    }
    const now = this.#now();
    const expiresAt = request.deadlineAt === undefined ? now + this.#maxActionTtlMs
      : futureDeadlineWithinLimit(request.deadlineAt, now, this.#maxActionTtlMs);
    const admission = await this.#acquireAdmission(page, caller, expiresAt);
    let pair;
    try {
      const result = await this.#mutationGate.run(lease, async () => {
        pair = await bindReferencePair({ kind: "drag", source: request.source, target: request.target,
          expectedScope: page, lease: { ...lease, taskId: page.taskId }, deadlineAt: expiresAt, registry: this.#registry,
          resolveRoute: (identity) => ({ ...this.#router.resolveFrameCommand({ pageScope: page, frameId: identity.frameId, expectedIdentity: identity }), identity }),
        });
        assertReferencePairCurrent(pair, { expectedScope: page, lease: { ...lease, taskId: page.taskId } });
        const source = this.#registry.resolve(request.source.refId, page);
        const target = this.#registry.resolve(request.target.refId, page);
        const route = this.#router.resolveFrameCommand({ pageScope: page, frameId: source.frameId, expectedIdentity: source });
        const attached = this.#router.attachClient({ pageScope: page, clientId: caller, targetId: route.targetId });
        return { source, target, route, attached };
      });
      if (this.#admissions.get(admission.id) !== admission || this.#now() >= expiresAt) {
        throw automationError("EGO_ACTION_EXPIRED", "Drag group expired while binding");
      }
      let token;
      do { token = randomUUID(); } while (this.#bindings.has(token));
      const binding = Object.freeze({ diagnosticId: this.#nextDiagnosticId++, token, version: "scoped-v1",
        pageScope: page, clientId: caller, lease, leaseKey: mutationKey(lease), identity: result.source,
        sessionId: result.attached.alias, nativeSessionGeneration: result.route.nativeSessionGeneration,
        admissionId: admission.id, expiresAt,
        group: { pair, members: [result.source, result.target], busy: false, phase: "preparing", mouseDownSent: false },
      });
      admission.members.add(token);
      this.#bindings.set(token, binding);
      this.#trace(binding, "group_bound");
      return Object.freeze({ version: "scoped-v1", kind: "drag", token, expiresAt,
        ...projectReferencePair(pair), ...(binding.sessionId ? { sessionId: binding.sessionId } : {}) });
    } catch (error) {
      if (pair) releaseReferencePair(pair);
      this.#releaseAdmission(admission);
      throw mapAutomationError(error, "bind");
    }
  }

  releaseReferenceAction({ pageScope, taskId, clientId, mutation, wire } = {}) {
    const caller = nonEmptyString(clientId, "clientId");
    if (!wire || wire.version !== "scoped-v1") throw automationError("EGO_ACTION_CONTEXT_INVALID", "Invalid scoped action wire");
    const token = nonEmptyString(wire.token, "wire.token");
    this.#cleanupRetiredGroups();
    const binding = this.#bindings.get(token);
    if (!binding) {
      const retired = this.#retiredGroupActions.get(token);
      if (!this.#matchesRetiredGroup(retired, { caller, taskId, pageScope, runtimeId: wire.runtimeId })) return false;
      return this.#retiredGroupActions.delete(token);
    }
    const page = pageScope === undefined ? binding.pageScope : normalizePageScope(pageScope);
    if (taskId !== undefined && taskId !== binding.pageScope.taskId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Action binding belongs to another task");
    }
    if (wire.runtimeId !== binding.pageScope.runtimeId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Action runtime does not match selected runtime");
    }
    const lease = normalizeMutation(mutation, binding.pageScope.taskId, caller);
    this.#assertBindingOwner(binding, page, caller, lease);
    this.#dropBinding(binding, "client_release");
    this.#retiredGroupActions.delete(token);
    return true;
  }

  async dispatchCdp({ pageScope, taskId, mutation, requestContext, payload } = {}) {
    const caller = nonEmptyString(requestContext?.clientId, "requestContext.clientId");
    if (requestContext?.refFormat !== "scoped-v1") {
      throw automationError("EGO_ACTION_CONTEXT_INVALID", "Scoped automation requires scoped-v1 request context");
    }
    const action = requestContext?.refAction;
    if (!action || action.version !== "scoped-v1") {
      throw automationError("EGO_ACTION_CONTEXT_INVALID", "Invalid scoped action wire");
    }
    const token = nonEmptyString(action.token, "refAction.token");
    this.#cleanupRetiredGroups();
    const binding = this.#bindings.get(token);
    if (!binding) {
      if (this.#matchesRetiredGroup(this.#retiredGroupActions.get(token), { caller, taskId, pageScope, runtimeId: action.runtimeId })) {
        throw automationError("EGO_ACTION_RESULT_UNKNOWN", "The retired drag may have reached its original page", { retry: "never", delivery: "unknown" });
      }
      throw automationError("EGO_ACTION_CONTEXT_INVALID", "Action binding is unknown or released");
    }
    const page = pageScope === undefined ? binding.pageScope : normalizePageScope(pageScope);
    if (taskId !== undefined && taskId !== binding.pageScope.taskId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Action binding belongs to another task");
    }
    if (action.runtimeId !== binding.pageScope.runtimeId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Action runtime does not match selected runtime");
    }
    const lease = normalizeMutation(mutation, page.taskId, caller);
    this.#assertBindingOwner(binding, page, caller, lease);
    if (binding.group) return this.#dispatchReferenceGroup(binding, page, lease, payload);
    const method = nonEmptyString(payload?.method, "payload.method");
    let nativeInvoked = false;
    this.#trace(binding, "dispatch", { method, requestId: payload?.id, type: payload?.params?.type });
    try {
      const route = this.#router.resolveFrameCommand({
        pageScope: page,
        frameId: binding.identity.frameId,
        expectedIdentity: binding.identity,
      });
      const prepared = prepareScopedPayload(payload, binding, route);
      return await this.#mutationGate.run(lease, async () => {
        if (this.#isPageSelected(page) !== true) {
          throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Bound page is no longer selected");
        }
        this.#registry.assertBoundActionCurrent(token, {
          expectedScope: fullExpectedScope(binding.identity),
          lease,
        });

        // All awaited native identity/node/visibility/focus checks happen before
        // the MutationGate's final asynchronous Broker authorization.
        this.#trace(binding, "validation_start", { method, requestId: payload?.id });
        const validation = await this.#validateBoundCommand(Object.freeze({
          pageScope: page,
          binding,
          route,
          method,
          params: prepared.params,
        }));
        this.#trace(binding, "validated", { method, requestId: payload?.id });

        const innerTarget = {
          debugger: {
            sendCommand: (nextMethod, nextParams) => {
              // No awaited work is permitted between these checks and nativeSend.
              this.#registry.assertBoundActionCurrent(token, {
                expectedScope: fullExpectedScope(binding.identity),
                lease,
              });
              if (this.#isPageSelected(page) !== true) {
                throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Bound page changed before native dispatch");
              }
              this.#mutationGate.assertMutationAllowed(page.taskId);
              const pending = this.#sendFrameCommand({
                pageScope: page,
                expectedIdentity: binding.identity,
                expectedNativeSessionGeneration: binding.nativeSessionGeneration,
              }, nextMethod, nextParams);
              nativeInvoked = true;
              this.#trace(binding, "native", { method, requestId: payload?.id, type: nextParams?.type });
              return Promise.resolve(pending).then((result) => {
                this.#trace(binding, "native_ack", { method, requestId: payload?.id });
                return result;
              }, (error) => {
                this.#trace(binding, "native_rejected", { method, requestId: payload?.id, code: error?.code });
                throw error;
              });
            },
          },
        };
        const guarded = this.#mutationGate.guardTarget(innerTarget, page.taskId);
        try {
          this.#trace(binding, "final_authorization_start", { method, requestId: payload?.id });
          return await guarded.debugger.sendCommand(method, prepared.params);
        } finally {
          await validation?.cleanup?.().catch(() => {});
        }
      });
    } catch (error) {
      this.#trace(binding, "dispatch_error", { method, code: error?.code, nativeInvoked,
        ...(method === "Input.dispatchMouseEvent" ? { pointerReason: error?.message } : {}) });
      if (nativeInvoked && MUTATING_METHOD.test(method)) {
        throw automationError(
          "EGO_ACTION_RESULT_UNKNOWN",
          "The scoped mutation may have reached the page",
          { retry: "never", delivery: "unknown" },
          error,
        );
      }
      throw mapAutomationError(error, "dispatch");
    }
  }

  #assertGroupCurrent(binding, page, lease) {
    if (this.#bindings.get(binding.token) !== binding) throw automationError("EGO_ACTION_CONTEXT_INVALID", "Drag group is released");
    this.#assertBindingOwner(binding, page, binding.clientId, lease);
    assertReferencePairCurrent(binding.group.pair, { expectedScope: page, lease: { ...lease, taskId: page.taskId } });
    if (this.#isPageSelected(page) !== true) throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Drag group page is no longer selected");
  }

  async #dispatchReferenceGroup(binding, page, lease, payload) {
    const group = binding.group;
    if (group.busy) throw automationError("EGO_ACTION_CONTEXT_INVALID", "Drag group already has a command in flight", { delivery: "not_sent", retry: "never" });
    group.busy = true;
    let method;
    let nativeInvoked = false;
    try {
      method = nonEmptyString(payload?.method, "payload.method");
      this.#assertGroupCurrent(binding, page, lease);
      if (!["Input.dispatchMouseEvent", "DOM.resolveNode", "DOM.getBoxModel", "DOM.scrollIntoViewIfNeeded", "DOM.describeNode",
        "Runtime.callFunctionOn", "Runtime.evaluate", "Runtime.releaseObject"].includes(method)) {
        throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Command is unsupported for a drag group");
      }
      if (method === "DOM.scrollIntoViewIfNeeded" && group.phase !== "preparing") {
        throw automationError("EGO_ACTION_CONTEXT_INVALID", "Drag scroll preparation must precede mouse down");
      }
      const type = payload?.params?.type;
      if (method === "Input.dispatchMouseEvent") {
        if ((type === "mousePressed" && group.phase !== "preparing")
          || (["mouseMoved", "mouseReleased"].includes(type) && group.phase !== "down")
          || !["mousePressed", "mouseMoved", "mouseReleased"].includes(type)
          || (type === "mousePressed" && (payload.params.button !== "left" || payload.params.buttons !== 1 || payload.params.clickCount !== 1))
          || (type === "mouseMoved" && payload.params.buttons !== 1)
          || (type === "mouseReleased" && (payload.params.button !== "left" || payload.params.buttons !== 0 || payload.params.clickCount !== 1))) {
          throw automationError("EGO_ACTION_CONTEXT_INVALID", "Drag input phase or button state is invalid");
        }
      }
      let identity = type === "mouseReleased" || type === "mouseMoved" ? group.members[1] : group.members[0];
      if (payload?.params?.backendNodeId !== undefined) {
        if (method === "Input.dispatchMouseEvent") {
          if (payload.params.backendNodeId !== identity.backendNodeId) throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Drag input conflicts with its phase endpoint");
        } else {
          identity = group.members.find((member) => member.backendNodeId === payload.params.backendNodeId);
          if (!identity) throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Drag command addresses an unbound node");
        }
      } else if (payload?.params?.objectId) {
        if (method === "Input.dispatchMouseEvent") throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Drag mouse input cannot select a Runtime receiver");
        if (typeof this.#resolveBoundObjectIdentity !== "function") throw automationError("EGO_ACTION_CONTEXT_INVALID", "Drag receiver resolution is unavailable");
        const backendNodeId = await this.#resolveBoundObjectIdentity({ pageScope: page, binding, objectId: payload.params.objectId });
        identity = group.members.find((member) => member.backendNodeId === backendNodeId);
        if (!identity) throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Drag receiver is not a bound member");
        this.#assertGroupCurrent(binding, page, lease);
      }
      const route = this.#router.resolveFrameCommand({ pageScope: page, frameId: identity.frameId, expectedIdentity: identity });
      const memberBinding = { ...binding, identity };
      const prepared = prepareScopedPayload(payload, memberBinding, route);
      return await this.#mutationGate.run(lease, async () => {
        this.#assertGroupCurrent(binding, page, lease);
        // Every command checks both endpoints. Intermediate movement has a
        // frame path policy; it is not required to hit either endpoint node.
        for (const member of new Set(group.members)) {
          await this.#validateBoundCommand({ pageScope: page, binding: { ...binding, identity: member }, route,
            method: member === identity ? method : "DOM.describeNode", params: member === identity ? prepared.params : {},
            ...(method === "Input.dispatchMouseEvent" && type === "mouseMoved" && member === identity ? { pointerPolicy: "path" } : {}),
          });
          this.#assertGroupCurrent(binding, page, lease);
        }
        const phase = group.phase;
        const innerTarget = { debugger: { sendCommand: (nextMethod, nextParams) => {
          this.#assertGroupCurrent(binding, page, lease);
          if (group.phase !== phase) throw automationError("EGO_ACTION_CONTEXT_INVALID", "Drag phase changed during authorization");
          this.#mutationGate.assertMutationAllowed(page.taskId);
          if (nextMethod === "Input.dispatchMouseEvent" && type === "mousePressed") {
            group.mouseDownSent = true;
            group.phase = "down";
          } else if (nextMethod === "Input.dispatchMouseEvent" && type === "mouseReleased") group.phase = "released";
          const pending = this.#sendFrameCommand({ pageScope: page, expectedIdentity: identity,
            expectedNativeSessionGeneration: binding.nativeSessionGeneration }, nextMethod, nextParams);
          nativeInvoked = true;
          return pending;
        } } };
        return this.#mutationGate.guardTarget(innerTarget, page.taskId).debugger.sendCommand(method, prepared.params);
      });
    } catch (error) {
      this.#dropBinding(binding, "group_command_failed");
      if (group.mouseDownSent || (nativeInvoked && MUTATING_METHOD.test(method))) {
        throw automationError("EGO_ACTION_RESULT_UNKNOWN", "The drag may have reached the page", { retry: "never", delivery: "unknown" }, error);
      }
      throw mapAutomationError(error, "dispatch");
    } finally {
      group.busy = false;
    }
  }

  consumeRouterEffects(effects) {
    if (!Array.isArray(effects)) throw new TypeError("Router effects must be an array");
    const remaining = [];
    for (const effect of effects) {
      if (effect?.type === "invalidate_documents") {
        this.#registry.invalidateDocuments(effect.identities || [], effect.reason);
        const invalid = new Set((effect.identities || []).map(documentKey));
        for (const binding of [...this.#bindings.values()]) {
          if (invalid.has(documentKey(binding.identity))) this.#dropBinding(binding, effect.reason || effect.type);
        }
      } else if (effect?.type === "invalidate_frame_subtree") {
        this.#registry.invalidateFrameSubtree(effect.pageScope, effect.frameIds || [], effect.reason);
        const frames = new Set(effect.frameIds || []);
        for (const binding of [...this.#bindings.values()]) {
          if (samePage(binding.pageScope, effect.pageScope) && frames.has(binding.identity.frameId)) this.#dropBinding(binding, effect.reason || effect.type);
        }
      } else if (effect?.type === "invalidate_page") {
        this.#registry.invalidatePage(effect.pageScope, effect.reason);
        this.#cancelPage(effect.pageScope, "Page was invalidated");
      } else if (effect?.type === "alias_retired") {
        for (const binding of [...this.#bindings.values()]) {
          if (binding.sessionId === effect.alias) this.#dropBinding(binding, effect.reason || effect.type);
        }
        remaining.push(effect);
      } else {
        remaining.push(effect);
      }
    }
    return Object.freeze(remaining);
  }

  disconnectClient({ taskId, clientId } = {}) {
    const task = nonEmptyString(taskId, "taskId");
    const caller = nonEmptyString(clientId, "clientId");
    for (const binding of [...this.#bindings.values()]) {
      if (binding.pageScope.taskId === task && binding.clientId === caller) this.#dropBinding(binding);
    }
    for (const admission of [...this.#admissions.values()]) {
      if (admission.pageScope.taskId === task && admission.clientId === caller) this.#expireAdmission(admission);
    }
    for (const state of this.#admissionPages.values()) {
      for (const queued of [...state.queue]) {
        if (queued.pageScope.taskId === task && queued.clientId === caller) {
          this.#removeQueued(state, queued);
          queued.reject(automationError("EGO_ACTION_CONTEXT_INVALID", "Client disconnected while waiting for action admission"));
        }
      }
    }
  }

  cancelTask(taskId, message = "Task control changed") {
    const task = nonEmptyString(taskId, "taskId");
    for (const binding of [...this.#bindings.values()]) {
      if (binding.pageScope.taskId === task) this.#dropBinding(binding, message);
    }
    for (const admission of [...this.#admissions.values()]) {
      if (admission.pageScope.taskId === task) this.#expireAdmission(admission);
    }
    for (const state of this.#admissionPages.values()) {
      for (const queued of [...state.queue]) {
        if (queued.pageScope.taskId === task) {
          this.#removeQueued(state, queued);
          queued.reject(automationError("EGO_ACTION_CONTEXT_INVALID", message));
        }
      }
    }
  }

  stats() {
    this.#cleanupRetiredGroups();
    let queued = 0;
    for (const state of this.#admissionPages.values()) queued += state.queue.length;
    return Object.freeze({
      bindings: this.#bindings.size,
      activeAdmissions: this.#admissions.size,
      admissionPages: this.#admissionPages.size,
      queuedAdmissions: queued,
      retiredGroups: this.#retiredGroupActions.size,
    });
  }

  #assertBindingOwner(binding, page, clientId, lease) {
    if (!samePage(binding.pageScope, page) || binding.clientId !== clientId
      || binding.leaseKey !== mutationKey(lease)) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Action binding belongs to another page, client, or lease");
    }
    if (this.#now() >= binding.expiresAt || !this.#admissions.has(binding.admissionId)) {
      this.#dropBinding(binding);
      throw automationError("EGO_ACTION_EXPIRED", "Action binding has expired");
    }
  }

  #trace(binding, phase, fields = {}) {
    try { this.#diagnose({ at: this.#now(), action: binding.diagnosticId, phase, frameId: binding.identity.frameId, ...fields }); } catch {}
  }

  #dropBinding(binding, reason = "control_or_page_changed") {
    if (this.#bindings.get(binding.token) !== binding) return false;
    this.#trace(binding, "drop", { reason });
    this.#bindings.delete(binding.token);
    if (binding.group?.mouseDownSent && binding.expiresAt > this.#now()) {
      this.#retiredGroupActions.set(binding.token, { clientId: binding.clientId, ...binding.pageScope,
        expiresAt: binding.expiresAt, delivery: "unknown" });
      this.#cleanupRetiredGroups();
    }
    if (binding.group) releaseReferencePair(binding.group.pair);
    else this.#registry.releaseBoundAction(binding.token);
    const admission = this.#admissions.get(binding.admissionId);
    admission?.members.delete(binding.token);
    if (admission && admission.members.size === 0) this.#releaseAdmission(admission);
    return true;
  }

  #cleanupRetiredGroups() {
    for (const [token, entry] of this.#retiredGroupActions) if (this.#now() >= entry.expiresAt) this.#retiredGroupActions.delete(token);
    while (this.#retiredGroupActions.size > this.#maxAdmissionPages) this.#retiredGroupActions.delete(this.#retiredGroupActions.keys().next().value);
  }

  #matchesRetiredGroup(entry, { caller, taskId, pageScope, runtimeId }) {
    return Boolean(entry && entry.clientId === caller && entry.runtimeId === runtimeId
      && (taskId === undefined || taskId === entry.taskId) && (pageScope === undefined || samePage(entry, pageScope)));
  }

  #acquireAdmission(pageScope, clientId, deadlineAt) {
    const key = pageKey(pageScope);
    let state = this.#admissionPages.get(key);
    if (!state) {
      if (this.#admissionPages.size >= this.#maxAdmissionPages) {
        return Promise.reject(automationError("EGO_ACTION_CONTEXT_INVALID", "Action admission page capacity is exhausted"));
      }
      state = { key, pageScope, active: undefined, queue: [] };
      this.#admissionPages.set(key, state);
    }
    const admission = {
      id: randomUUID(),
      pageKey: key,
      pageScope,
      clientId,
      deadlineAt,
      members: new Set(),
      timer: undefined,
      resolve: undefined,
      reject: undefined,
    };
    if (!state.active) {
      this.#activateAdmission(state, admission);
      return Promise.resolve(admission);
    }
    if (state.queue.length >= this.#maxQueuedPerPage) {
      return Promise.reject(automationError("EGO_ACTION_CONTEXT_INVALID", "Action admission queue is full"));
    }
    return new Promise((resolve, reject) => {
      admission.resolve = resolve;
      admission.reject = reject;
      admission.timer = this.#schedule(() => {
        this.#removeQueued(state, admission);
        reject(automationError("EGO_ACTION_EXPIRED", "Action admission deadline expired while queued"));
      }, Math.max(0, deadlineAt - this.#now()));
      admission.timer?.unref?.();
      state.queue.push(admission);
    });
  }

  #activateAdmission(state, admission) {
    state.active = admission;
    this.#admissions.set(admission.id, admission);
    admission.timer = this.#schedule(() => this.#expireAdmission(admission), Math.max(0, admission.deadlineAt - this.#now()));
    admission.timer?.unref?.();
    admission.resolve?.(admission);
  }

  #expireAdmission(admission) {
    for (const token of [...admission.members]) {
      const binding = this.#bindings.get(token);
      if (binding) this.#dropBinding(binding, "admission_expired");
    }
    admission.members.clear();
    this.#releaseAdmission(admission);
  }

  #releaseAdmission(admission) {
    if (this.#admissions.get(admission.id) !== admission) return;
    this.#admissions.delete(admission.id);
    if (admission.timer !== undefined) this.#cancel(admission.timer);
    const state = this.#admissionPages.get(admission.pageKey);
    if (!state || state.active !== admission) return;
    state.active = undefined;
    while (state.queue.length) {
      const next = state.queue.shift();
      if (next.timer !== undefined) this.#cancel(next.timer);
      if (this.#now() >= next.deadlineAt) {
        next.reject(automationError("EGO_ACTION_EXPIRED", "Action admission deadline expired while queued"));
        continue;
      }
      this.#activateAdmission(state, next);
      return;
    }
    this.#admissionPages.delete(admission.pageKey);
  }

  #removeQueued(state, admission) {
    const index = state.queue.indexOf(admission);
    if (index >= 0) state.queue.splice(index, 1);
    if (admission.timer !== undefined) this.#cancel(admission.timer);
    if (!state.active && state.queue.length === 0) this.#admissionPages.delete(state.key);
  }

  #cancelPage(pageScope, message) {
    for (const binding of [...this.#bindings.values()]) {
      if (samePage(binding.pageScope, pageScope)) this.#dropBinding(binding);
    }
    const state = this.#admissionPages.get(pageKey(pageScope));
    if (!state) return;
    for (const queued of [...state.queue]) {
      this.#removeQueued(state, queued);
      queued.reject(automationError("EGO_REFERENCE_STALE", message, { retry: "resnapshot", delivery: "not_sent" }));
    }
    if (state.active) this.#expireAdmission(state.active);
  }
}

function prepareScopedPayload(payload, binding, route) {
  if (!payload || typeof payload !== "object") throw new TypeError("CDP payload must be an object");
  if (payload.sessionId !== undefined && payload.sessionId !== binding.sessionId) {
    throw automationError("EGO_ACTION_SCOPE_MISMATCH", "CDP session alias conflicts with the bound frame route");
  }
  const method = nonEmptyString(payload.method, "payload.method");
  const params = { ...(payload.params || {}) };
  if (params.backendNodeId !== undefined && params.backendNodeId !== binding.identity.backendNodeId) {
    throw automationError("EGO_ACTION_SCOPE_MISMATCH", "CDP backend node does not match the bound reference");
  }
  if (method === "DOM.resolveNode") {
    if (params.backendNodeId === undefined) params.backendNodeId = binding.identity.backendNodeId;
    if (params.executionContextId !== undefined && params.executionContextId !== route.executionContextId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "DOM resolution uses a foreign execution context");
    }
    params.executionContextId = route.executionContextId;
  }
  if (method === "Runtime.evaluate") {
    if (params.contextId !== undefined && params.contextId !== route.executionContextId) {
      throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Runtime evaluation uses a foreign execution context");
    }
    params.contextId = route.executionContextId;
  }
  return Object.freeze({ method, params: Object.freeze(params) });
}

function mapAutomationError(error, phase) {
  if (error instanceof DesktopScopedAutomationError) return error;
  const code = error?.code;
  if (["REFERENCE_SCOPE_MISMATCH", "ACTION_CONTEXT_MISMATCH", "FOREIGN_ALIAS", "FOREIGN_SESSION", "REFERENCE_PAIR_SCOPE_MISMATCH", "REFERENCE_PAIR_ROUTE_MISMATCH"].includes(code)) {
    return automationError("EGO_ACTION_SCOPE_MISMATCH", error.message, { retry: "never", delivery: "not_sent" }, error);
  }
  if (["ACTION_CONTEXT_EXPIRED"].includes(code)) {
    return automationError("EGO_ACTION_EXPIRED", error.message, { retry: "never", delivery: "not_sent" }, error);
  }
  if (["ACTION_CONTEXT_INVALID", "ACTION_CONTEXT_STALE", "ACTION_CONTEXT_CAPACITY_EXCEEDED", "REFERENCE_PAIR_RELEASED"].includes(code)) {
    return automationError("EGO_ACTION_CONTEXT_INVALID", error.message, { retry: "never", delivery: "not_sent" }, error);
  }
  if ([
    "REFERENCE_UNKNOWN", "REFERENCE_STALE", "REFERENCE_DOCUMENT_NOT_CURRENT", "REFERENCE_SCOPE_INVALIDATED",
    "SNAPSHOT_STALE", "SNAPSHOT_TICKET_INVALID", "PAGE_CLOSED", "UNKNOWN_PAGE", "STALE_DOCUMENT",
    "REFERENCE_PAIR_STALE",
  ].includes(code)) {
    return automationError("EGO_REFERENCE_STALE", error.message, { retry: "resnapshot", delivery: "not_sent" }, error);
  }
  if (code === "REFERENCE_NODE_DETACHED") {
    return automationError("EGO_REFERENCE_DETACHED", error.message, { retry: "never", delivery: "not_sent" }, error);
  }
  if ([
    "DETACHED_FRAME", "DETACHED_SESSION", "FRAME_SWAPPING", "FRAME_CONTEXT_UNAVAILABLE", "FRAME_UNRESOLVED",
    "STALE_SESSION_ROUTE", "NATIVE_DOCUMENT_UNAVAILABLE",
  ].includes(code)) {
    return automationError("EGO_FRAME_UNAVAILABLE", error.message, { retry: "resnapshot", delivery: "not_sent" }, error);
  }
  return automationError("EGO_SCOPED_AUTOMATION_FAILED", `${phase} failed: ${error?.message || String(error)}`, {
    retry: "never",
    delivery: "not_sent",
  }, error);
}

function automationError(code, message, data = {}, cause) {
  return new DesktopScopedAutomationError(code, message, data, cause ? { cause } : undefined);
}

function normalizePageScope(scope) {
  if (!scope || typeof scope !== "object") throw new TypeError("pageScope must be an object");
  return Object.freeze({
    runtimeId: nonEmptyString(scope.runtimeId, "pageScope.runtimeId"),
    taskId: nonEmptyString(scope.taskId, "pageScope.taskId"),
    pageId: nonEmptyString(scope.pageId, "pageScope.pageId"),
  });
}

function normalizeMutation(mutation, taskId, clientId) {
  if (!mutation || typeof mutation !== "object") throw new TypeError("mutation tuple must be an object");
  const lease = Object.freeze({
    taskId,
    taskSpaceId: positiveSafeInteger(mutation.taskSpaceId, "mutation.taskSpaceId"),
    clientId: nonEmptyString(mutation.clientId, "mutation.clientId"),
    leaseEpoch: nonNegativeSafeInteger(mutation.leaseEpoch, "mutation.leaseEpoch"),
  });
  if (lease.clientId !== clientId) throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Mutation client does not match connection client");
  return lease;
}

function normalizeActionWire(wire, runtimeId) {
  if (!wire || wire.version !== "scoped-v1") throw automationError("EGO_ACTION_CONTEXT_INVALID", "Invalid scoped action wire");
  if (wire.runtimeId !== runtimeId) throw automationError("EGO_ACTION_SCOPE_MISMATCH", "Action runtime does not match selected runtime");
  return nonEmptyString(wire.token, "wire.token");
}

function fullExpectedScope(identity) {
  return Object.freeze({
    runtimeId: identity.runtimeId,
    taskId: identity.taskId,
    pageId: identity.pageId,
    frameId: identity.frameId,
    documentId: identity.documentId,
    documentEpoch: identity.documentEpoch,
  });
}

function mutationKey(mutation) {
  return JSON.stringify([mutation.taskId, mutation.taskSpaceId, mutation.clientId, mutation.leaseEpoch]);
}

function pageKey(scope) {
  return JSON.stringify([scope.runtimeId, scope.taskId, scope.pageId]);
}

function documentKey(identity) {
  return JSON.stringify([
    identity.runtimeId, identity.taskId, identity.pageId, identity.frameId,
    identity.documentId, identity.documentEpoch,
  ]);
}

function samePage(left, right) {
  return left.runtimeId === right?.runtimeId && left.taskId === right?.taskId && left.pageId === right?.pageId;
}

function futureDeadlineWithinLimit(value, now, maximumTtlMs) {
  if (!Number.isFinite(value) || value <= now) throw automationError("EGO_ACTION_EXPIRED", "Action deadline must be in the future");
  if (value - now > maximumTtlMs) {
    throw automationError("EGO_ACTION_CONTEXT_INVALID", "Requested action deadline exceeds the host maximum");
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}
