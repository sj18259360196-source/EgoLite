import { randomBytes } from "node:crypto";

const DEFAULT_ACTION_TTL_MS = 30_000;
const DEFAULT_SNAPSHOT_TTL_MS = 30_000;

export class DesktopReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopReferenceError";
    this.code = code;
  }
}

export class DesktopReferenceRegistry {
  #allocator;
  #maxLiveRefs;
  #maxTombstones;
  #maxActionContexts;
  #maxPendingSnapshots;
  #maxDocumentStates;
  #maxActionContextTtlMs;
  #snapshotTicketTtlMs;
  #now;
  #revalidateAction;
  #isCurrentDocument;

  #liveById = new Map();
  #refByNode = new Map();
  #refsByDocument = new Map();
  #documentStates = new Map();
  #tombstones = new Map();
  #scopeTombstones = new Map();
  #snapshotTickets = new Map();
  #actionContexts = new Map();

  constructor(options = {}) {
    if (!options.allocator || typeof options.allocator.allocate !== "function") {
      throw new TypeError("DesktopReferenceRegistry requires an allocator");
    }
    if (typeof options.revalidateAction !== "function") {
      throw new TypeError("DesktopReferenceRegistry requires a revalidateAction callback");
    }
    if (typeof options.isCurrentDocument !== "function") {
      throw new TypeError("DesktopReferenceRegistry requires a synchronous isCurrentDocument callback");
    }
    this.#allocator = options.allocator;
    this.#maxLiveRefs = positiveInteger(options.maxLiveRefs ?? 50_000, "maxLiveRefs");
    this.#maxTombstones = positiveInteger(options.maxTombstones ?? 10_000, "maxTombstones");
    this.#maxActionContexts = positiveInteger(options.maxActionContexts ?? 10_000, "maxActionContexts");
    this.#maxPendingSnapshots = positiveInteger(options.maxPendingSnapshots ?? 1_000, "maxPendingSnapshots");
    this.#maxDocumentStates = positiveInteger(options.maxDocumentStates ?? 10_000, "maxDocumentStates");
    this.#maxActionContextTtlMs = positiveInteger(
      options.maxActionContextTtlMs ?? DEFAULT_ACTION_TTL_MS,
      "maxActionContextTtlMs",
    );
    this.#snapshotTicketTtlMs = positiveInteger(
      options.snapshotTicketTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
      "snapshotTicketTtlMs",
    );
    this.#now = options.now || Date.now;
    if (typeof this.#now !== "function") throw new TypeError("now must be a function");
    this.#revalidateAction = options.revalidateAction;
    this.#isCurrentDocument = options.isCurrentDocument;
  }

  beginSnapshot(identity) {
    const document = normalizeDocumentIdentity(identity);
    this.#cleanupExpired();
    this.#assertCurrentDocument(document);
    if (this.#snapshotTickets.size >= this.#maxPendingSnapshots) {
      throw referenceError("SNAPSHOT_CAPACITY_EXCEEDED", "Too many snapshots are pending");
    }
    const key = documentKey(document);
    const state = this.#documentState(document);
    const sequence = state.nextSequence;
    state.nextSequence += 1;
    const token = this.#newToken("snapshot", this.#snapshotTickets);
    this.#snapshotTickets.set(token, Object.freeze({
      token,
      document,
      documentKey: key,
      invalidationEpoch: state.invalidationEpoch,
      sequence,
      expiresAt: this.#now() + this.#snapshotTicketTtlMs,
    }));
    return token;
  }

  discardSnapshot(ticketToken) {
    return this.#snapshotTickets.delete(ticketToken);
  }

  commitSnapshot(ticketToken, { mode, nodes } = {}) {
    this.#cleanupExpired();
    const ticket = this.#snapshotTickets.get(ticketToken);
    if (!ticket) throw referenceError("SNAPSHOT_TICKET_INVALID", "Snapshot ticket is unknown or expired");
    this.#snapshotTickets.delete(ticketToken);

    if (mode !== "full_document" && mode !== "partial") {
      throw new TypeError("Snapshot mode must be full_document or partial");
    }
    if (!Array.isArray(nodes)) throw new TypeError("Snapshot nodes must be an array");
    if (nodes.length > this.#maxLiveRefs) {
      throw referenceError("SNAPSHOT_TOO_LARGE", "Snapshot contains more nodes than the live reference limit");
    }

    this.#assertCurrentDocument(ticket.document);
    const state = this.#documentStates.get(ticket.documentKey);
    if (!state || state.invalidationEpoch !== ticket.invalidationEpoch) {
      throw referenceError("SNAPSHOT_STALE", "Snapshot crossed a document invalidation boundary");
    }
    if (ticket.sequence < state.latestCommittedFullSequence) {
      throw referenceError("SNAPSHOT_STALE", "Snapshot predates an already committed full snapshot");
    }
    if (mode === "full_document" && ticket.sequence < state.latestCommittedSequence) {
      throw referenceError("SNAPSHOT_STALE", "Full snapshot is older than an already committed snapshot");
    }

    const normalizedNodes = [];
    const requestedNodeKeys = new Set();
    for (const node of nodes) {
      const backendNodeId = positiveSafeInteger(node?.backendNodeId, "backendNodeId");
      const key = nodeKey(ticket.document, backendNodeId);
      if (requestedNodeKeys.has(key)) {
        throw referenceError("SNAPSHOT_DUPLICATE_NODE", "Snapshot contains a duplicate backend node ID");
      }
      requestedNodeKeys.add(key);
      normalizedNodes.push({ backendNodeId, key });
    }

    const allocatedIds = new Map();
    const allocatedIdSet = new Set();
    for (const node of normalizedNodes) {
      if (this.#refByNode.has(node.key)) continue;
      const refId = this.#allocator.allocate();
      if (!Number.isSafeInteger(refId) || refId <= 0 || this.#liveById.has(refId)
        || this.#tombstones.has(refId) || allocatedIdSet.has(refId)) {
        throw referenceError("REFERENCE_ALLOCATOR_INVALID", "Reference allocator returned an invalid or reused ID");
      }
      allocatedIds.set(node.key, refId);
      allocatedIdSet.add(refId);
    }

    if (mode === "full_document") {
      for (const refId of [...(this.#refsByDocument.get(ticket.documentKey) || [])]) {
        const record = this.#liveById.get(refId);
        if (record && !requestedNodeKeys.has(nodeKey(record, record.backendNodeId))) {
          this.#retire(refId, "full_document_replaced");
        }
      }
    }

    const protectedIds = new Set();
    for (const node of normalizedNodes) {
      const existing = this.#refByNode.get(node.key);
      if (existing !== undefined) protectedIds.add(existing);
    }
    this.#makeCapacity(allocatedIds.size, protectedIds);

    const records = [];
    for (const node of normalizedNodes) {
      let refId = this.#refByNode.get(node.key);
      if (refId === undefined) {
        refId = allocatedIds.get(node.key);
        const record = Object.freeze({
          ref: formatPublicReference(refId),
          refId,
          ...ticket.document,
          backendNodeId: node.backendNodeId,
        });
        this.#liveById.set(refId, record);
        this.#refByNode.set(node.key, refId);
        let documentRefs = this.#refsByDocument.get(ticket.documentKey);
        if (!documentRefs) {
          documentRefs = new Set();
          this.#refsByDocument.set(ticket.documentKey, documentRefs);
        }
        documentRefs.add(refId);
      }
      this.#touch(refId);
      records.push(this.#liveById.get(refId));
    }

    state.latestCommittedSequence = Math.max(state.latestCommittedSequence, ticket.sequence);
    if (mode === "full_document") state.latestCommittedFullSequence = ticket.sequence;
    return Object.freeze(records);
  }

  resolve(reference, expectedScope) {
    const refId = parsePublicReference(reference);
    const expected = normalizeExpectedScope(expectedScope);
    const record = this.#liveById.get(refId);
    if (!record) {
      const tombstone = this.#tombstones.get(refId);
      throw referenceError(
        tombstone ? "REFERENCE_STALE" : "REFERENCE_UNKNOWN",
        tombstone ? `Reference is stale (${tombstone.reason})` : "Reference is unknown",
      );
    }
    assertScopeMatches(record, expected);
    this.#assertCurrentDocument(record);
    this.#touch(refId);
    return record;
  }

  async bindAction(reference, { expectedScope, lease, deadlineAt } = {}) {
    this.#cleanupExpired();
    if (this.#actionContexts.size >= this.#maxActionContexts) {
      throw referenceError("ACTION_CONTEXT_CAPACITY_EXCEEDED", "Too many action contexts are active");
    }
    const expected = normalizeExpectedScope(expectedScope);
    const callerLease = normalizeLease(lease, expected.taskId);
    const now = this.#now();
    const expiresAt = deadlineAt === undefined
      ? now + this.#maxActionContextTtlMs
      : Math.min(validateDeadline(deadlineAt, now), now + this.#maxActionContextTtlMs);
    let identity = this.resolve(reference, expected);
    const token = this.#newToken("action", this.#actionContexts);
    const context = Object.freeze({
      token,
      refId: identity.refId,
      identityKey: identityKey(identity),
      expected,
      expectedKey: expectedScopeKey(expected),
      lease: callerLease,
      leaseKey: leaseKey(callerLease),
      expiresAt,
    });
    // The pending context reserves capacity before asynchronous authorization.
    this.#actionContexts.set(token, context);
    try {
      await this.#revalidateAction({ phase: "bind", identity, lease: callerLease, expiresAt });
      if (this.#actionContexts.get(token) !== context) {
        throw referenceError("ACTION_CONTEXT_INVALID", "Action context was released during binding");
      }
      if (this.#now() >= expiresAt) {
        throw referenceError("ACTION_CONTEXT_EXPIRED", "Action context deadline expired during binding");
      }
      this.#assertCurrentDocument(identity);
      identity = this.resolve(identity.refId, expected);
      if (identityKey(identity) !== context.identityKey) {
        throw referenceError("ACTION_CONTEXT_STALE", "Action context changed during binding");
      }
      return token;
    } catch (error) {
      if (this.#actionContexts.get(token) === context) this.#actionContexts.delete(token);
      throw error;
    }
  }

  async revalidateBoundAction(token, { expectedScope, lease } = {}) {
    this.#cleanupExpired();
    const context = this.#actionContexts.get(token);
    if (!context) throw referenceError("ACTION_CONTEXT_INVALID", "Action context is unknown or expired");
    const expected = normalizeExpectedScope(expectedScope);
    const callerLease = normalizeLease(lease, expected.taskId);
    if (expectedScopeKey(expected) !== context.expectedKey || leaseKey(callerLease) !== context.leaseKey) {
      throw referenceError("ACTION_CONTEXT_MISMATCH", "Action context caller, task, scope, or lease changed");
    }
    if (this.#now() >= context.expiresAt) {
      this.#actionContexts.delete(token);
      throw referenceError("ACTION_CONTEXT_EXPIRED", "Action context has expired");
    }
    let identity = this.resolve(context.refId, expected);
    if (identityKey(identity) !== context.identityKey) {
      throw referenceError("ACTION_CONTEXT_STALE", "Action context no longer resolves to its original node");
    }
    await this.#revalidateAction({
      phase: "use",
      identity,
      lease: callerLease,
      expiresAt: context.expiresAt,
    });
    if (this.#actionContexts.get(token) !== context) {
      throw referenceError("ACTION_CONTEXT_INVALID", "Action context was released during revalidation");
    }
    if (this.#now() >= context.expiresAt) {
      this.#actionContexts.delete(token);
      throw referenceError("ACTION_CONTEXT_EXPIRED", "Action context expired during revalidation");
    }
    this.#assertCurrentDocument(identity);
    identity = this.resolve(context.refId, expected);
    if (identityKey(identity) !== context.identityKey) {
      throw referenceError("ACTION_CONTEXT_STALE", "Action context changed during revalidation");
    }
    return identity;
  }

  assertBoundActionCurrent(token, { expectedScope, lease } = {}) {
    const context = this.#actionContexts.get(token);
    if (!context) throw referenceError("ACTION_CONTEXT_INVALID", "Action context is unknown or released");
    const expected = normalizeExpectedScope(expectedScope);
    const callerLease = normalizeLease(lease, expected.taskId);
    if (expectedScopeKey(expected) !== context.expectedKey || leaseKey(callerLease) !== context.leaseKey) {
      throw referenceError("ACTION_CONTEXT_MISMATCH", "Action context caller, task, scope, or lease changed");
    }
    if (this.#now() >= context.expiresAt) {
      this.#actionContexts.delete(token);
      throw referenceError("ACTION_CONTEXT_EXPIRED", "Action context has expired");
    }
    const identity = this.resolve(context.refId, expected);
    if (identityKey(identity) !== context.identityKey) {
      throw referenceError("ACTION_CONTEXT_STALE", "Action context no longer resolves to its original node");
    }
    return identity;
  }

  releaseBoundAction(token) {
    return this.#actionContexts.delete(token);
  }

  invalidateDocuments(documentScopes, reason = "document_invalidated") {
    if (!Array.isArray(documentScopes)) throw new TypeError("documentScopes must be an array");
    for (const scope of documentScopes) {
      const document = normalizeDocumentIdentity(scope);
      this.#invalidateDocument(document, reason);
    }
  }

  invalidateFrameSubtree(pageScope, frameIds, reason = "frame_subtree_invalidated") {
    const page = normalizePageScope(pageScope);
    if (!Array.isArray(frameIds)) throw new TypeError("frameIds must be an array");
    const frames = new Set(frameIds.map((frameId) => nonEmptyString(frameId, "frameId")));
    for (const state of this.#documentStates.values()) {
      if (samePage(state.identity, page) && frames.has(state.identity.frameId)) {
        this.#invalidateDocument(state.identity, reason);
      }
    }
  }

  invalidatePage(pageScope, reason = "page_invalidated") {
    const page = normalizePageScope(pageScope);
    this.#addScopeTombstone(pageTombstoneKey(page), reason);
    for (const state of this.#documentStates.values()) {
      if (samePage(state.identity, page)) this.#invalidateDocumentState(state, reason);
    }
  }

  invalidateRuntime(runtimeId, reason = "runtime_invalidated") {
    const runtime = nonEmptyString(runtimeId, "runtimeId");
    this.#addScopeTombstone(runtimeTombstoneKey(runtime), reason);
    for (const state of this.#documentStates.values()) {
      if (state.identity.runtimeId === runtime) this.#invalidateDocumentState(state, reason);
    }
  }

  stats() {
    this.#cleanupExpired();
    return Object.freeze({
      liveRefs: this.#liveById.size,
      tombstones: this.#tombstones.size,
      invalidatedScopes: this.#scopeTombstones.size,
      documents: this.#documentStates.size,
      pendingSnapshots: this.#snapshotTickets.size,
      actionContexts: this.#actionContexts.size,
    });
  }

  #documentState(document) {
    const key = documentKey(document);
    let state = this.#documentStates.get(key);
    if (!state) {
      this.#makeDocumentCapacity();
      state = {
        identity: document,
        invalidationEpoch: 0,
        nextSequence: 1,
        latestCommittedSequence: 0,
        latestCommittedFullSequence: 0,
      };
      this.#documentStates.set(key, state);
    }
    return state;
  }

  #invalidateDocument(document, reason) {
    this.#addScopeTombstone(documentTombstoneKey(document), reason);
    const state = this.#documentStates.get(documentKey(document));
    if (state) this.#invalidateDocumentState(state, reason);
  }

  #invalidateDocumentState(state, reason) {
    state.invalidationEpoch += 1;
    const key = documentKey(state.identity);
    for (const refId of [...(this.#refsByDocument.get(key) || [])]) this.#retire(refId, reason);
  }

  #assertCurrentDocument(identity) {
    const document = documentIdentityFrom(identity);
    const current = this.#isCurrentDocument(document);
    if (current && typeof current.then === "function") {
      throw new TypeError("isCurrentDocument must return synchronously");
    }
    if (current !== true) {
      throw referenceError("REFERENCE_DOCUMENT_NOT_CURRENT", "Document identity is no longer current");
    }
  }

  #makeCapacity(newCount, protectedIds) {
    let needed = this.#liveById.size + newCount - this.#maxLiveRefs;
    if (needed <= 0) return;
    for (const refId of [...this.#liveById.keys()]) {
      if (needed <= 0) break;
      if (protectedIds.has(refId)) continue;
      this.#retire(refId, "capacity_evicted");
      needed -= 1;
    }
    if (needed > 0) throw referenceError("REFERENCE_CAPACITY_EXCEEDED", "Live reference capacity is exhausted");
  }

  #makeDocumentCapacity() {
    if (this.#documentStates.size < this.#maxDocumentStates) return;
    const pendingDocuments = new Set([...this.#snapshotTickets.values()].map((ticket) => ticket.documentKey));
    for (const [key] of this.#documentStates) {
      if (this.#documentStates.size < this.#maxDocumentStates) break;
      if (this.#refsByDocument.has(key) || pendingDocuments.has(key)) continue;
      this.#documentStates.delete(key);
    }
    if (this.#documentStates.size >= this.#maxDocumentStates) {
      throw referenceError("DOCUMENT_STATE_CAPACITY_EXCEEDED", "Document state capacity is exhausted");
    }
  }

  #retire(refId, reason) {
    const record = this.#liveById.get(refId);
    if (!record) return;
    this.#liveById.delete(refId);
    this.#refByNode.delete(nodeKey(record, record.backendNodeId));
    const key = documentKey(record);
    const documentRefs = this.#refsByDocument.get(key);
    documentRefs?.delete(refId);
    if (documentRefs?.size === 0) this.#refsByDocument.delete(key);
    this.#boundedSet(this.#tombstones, refId, Object.freeze({
      reason: normalizedReason(reason),
      retiredAt: this.#now(),
    }), this.#maxTombstones);
  }

  #touch(refId) {
    const record = this.#liveById.get(refId);
    if (!record) return;
    this.#liveById.delete(refId);
    this.#liveById.set(refId, record);
  }

  #addScopeTombstone(key, reason) {
    this.#boundedSet(this.#scopeTombstones, key, Object.freeze({
      reason: normalizedReason(reason),
      invalidatedAt: this.#now(),
    }), this.#maxTombstones);
  }

  #boundedSet(map, key, value, maximum) {
    map.delete(key);
    map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value);
  }

  #cleanupExpired() {
    const now = this.#now();
    for (const [token, ticket] of this.#snapshotTickets) {
      if (now >= ticket.expiresAt) this.#snapshotTickets.delete(token);
    }
    for (const [token, context] of this.#actionContexts) {
      if (now >= context.expiresAt) this.#actionContexts.delete(token);
    }
  }

  #newToken(prefix, map) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = `${prefix}_${randomBytes(24).toString("base64url")}`;
      if (!map.has(token)) return token;
    }
    throw referenceError("TOKEN_GENERATION_FAILED", "Could not generate a unique opaque token");
  }
}

export function formatPublicReference(refId) {
  return `@${positiveSafeInteger(refId, "refId")}`;
}

export function parsePublicReference(reference) {
  if (Number.isSafeInteger(reference) && reference > 0) return reference;
  if (typeof reference !== "string" || !/^@[1-9]\d*$/.test(reference)) {
    throw referenceError("REFERENCE_FORMAT_INVALID", "Reference must use @<positive decimal> syntax");
  }
  const value = Number(reference.slice(1));
  if (!Number.isSafeInteger(value)) {
    throw referenceError("REFERENCE_FORMAT_INVALID", "Reference ID exceeds the safe integer range");
  }
  return value;
}

function normalizeDocumentIdentity(identity) {
  if (!identity || typeof identity !== "object") throw new TypeError("Document identity must be an object");
  return Object.freeze({
    runtimeId: nonEmptyString(identity.runtimeId, "runtimeId"),
    taskId: nonEmptyString(identity.taskId, "taskId"),
    pageId: nonEmptyString(identity.pageId, "pageId"),
    frameId: nonEmptyString(identity.frameId, "frameId"),
    documentId: nonEmptyString(identity.documentId, "documentId"),
    documentEpoch: nonNegativeSafeInteger(identity.documentEpoch, "documentEpoch"),
  });
}

function documentIdentityFrom(identity) {
  return Object.freeze({
    runtimeId: identity.runtimeId,
    taskId: identity.taskId,
    pageId: identity.pageId,
    frameId: identity.frameId,
    documentId: identity.documentId,
    documentEpoch: identity.documentEpoch,
  });
}

function normalizePageScope(scope) {
  if (!scope || typeof scope !== "object") throw new TypeError("Page scope must be an object");
  return Object.freeze({
    runtimeId: nonEmptyString(scope.runtimeId, "runtimeId"),
    taskId: nonEmptyString(scope.taskId, "taskId"),
    pageId: nonEmptyString(scope.pageId, "pageId"),
  });
}

function normalizeExpectedScope(scope) {
  const page = normalizePageScope(scope);
  const expected = { ...page };
  if (scope.frameId !== undefined) expected.frameId = nonEmptyString(scope.frameId, "frameId");
  if (scope.documentId !== undefined) expected.documentId = nonEmptyString(scope.documentId, "documentId");
  if (scope.documentEpoch !== undefined) {
    expected.documentEpoch = nonNegativeSafeInteger(scope.documentEpoch, "documentEpoch");
  }
  return Object.freeze(expected);
}

function normalizeLease(lease, taskId) {
  if (!lease || typeof lease !== "object") throw new TypeError("Lease identity must be an object");
  const normalized = Object.freeze({
    taskId: nonEmptyString(lease.taskId, "lease.taskId"),
    taskSpaceId: positiveSafeInteger(lease.taskSpaceId, "lease.taskSpaceId"),
    clientId: nonEmptyString(lease.clientId, "lease.clientId"),
    leaseEpoch: nonNegativeSafeInteger(lease.leaseEpoch, "lease.leaseEpoch"),
  });
  if (normalized.taskId !== taskId) {
    throw referenceError("ACTION_CONTEXT_MISMATCH", "Lease task does not match the reference task");
  }
  return normalized;
}

function assertScopeMatches(identity, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (identity[key] !== value) {
      throw referenceError("REFERENCE_SCOPE_MISMATCH", `Reference does not belong to expected ${key}`);
    }
  }
}

function documentKey(identity) {
  return JSON.stringify([
    identity.runtimeId,
    identity.taskId,
    identity.pageId,
    identity.frameId,
    identity.documentId,
    identity.documentEpoch,
  ]);
}

function nodeKey(identity, backendNodeId) {
  return `${documentKey(identity)}\u0000${backendNodeId}`;
}

function identityKey(identity) {
  return `${nodeKey(identity, identity.backendNodeId)}\u0000${identity.refId}`;
}

function expectedScopeKey(scope) {
  return JSON.stringify([
    scope.runtimeId,
    scope.taskId,
    scope.pageId,
    scope.frameId ?? null,
    scope.documentId ?? null,
    scope.documentEpoch ?? null,
  ]);
}

function leaseKey(lease) {
  return JSON.stringify([lease.taskId, lease.taskSpaceId, lease.clientId, lease.leaseEpoch]);
}

function samePage(identity, page) {
  return identity.runtimeId === page.runtimeId
    && identity.taskId === page.taskId
    && identity.pageId === page.pageId;
}

function runtimeTombstoneKey(runtimeId) {
  return `runtime\u0000${runtimeId}`;
}

function pageTombstoneKey(identity) {
  return `page\u0000${JSON.stringify([identity.runtimeId, identity.taskId, identity.pageId])}`;
}

function documentTombstoneKey(identity) {
  return `document\u0000${documentKey(identity)}`;
}

function validateDeadline(deadlineAt, now) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= now) {
    throw referenceError("ACTION_CONTEXT_EXPIRED", "Action deadline must be in the future");
  }
  return deadlineAt;
}

function normalizedReason(reason) {
  if (typeof reason !== "string" || reason.length === 0) return "invalidated";
  return reason.slice(0, 128);
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

function positiveInteger(value, name) {
  return positiveSafeInteger(value, name);
}

function referenceError(code, message) {
  return new DesktopReferenceError(code, message);
}
