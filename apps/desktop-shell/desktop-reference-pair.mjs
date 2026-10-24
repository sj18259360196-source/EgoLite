const INTERNAL = Symbol("desktopReferencePairState");

export class DesktopReferencePairError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DesktopReferencePairError";
    this.code = code;
  }
}

export async function bindReferencePair({
  kind,
  source,
  target,
  expectedScope,
  lease,
  deadlineAt,
  registry,
  resolveRoute,
} = {}) {
  assertDependencies(registry, resolveRoute);
  if (kind !== "drag") throw new TypeError("Reference pair kind must be drag");
  const scope = normalizePageScope(expectedScope);
  const normalizedLease = normalizeLease(lease, scope.taskId);
  const sourceDescriptor = normalizeDescriptor(source, "source");
  const targetDescriptor = normalizeDescriptor(target, "target");
  if (sourceDescriptor.runtimeId !== scope.runtimeId || targetDescriptor.runtimeId !== scope.runtimeId) {
    throw pairError("REFERENCE_PAIR_SCOPE_MISMATCH", "Pair member runtime does not match the trusted page scope");
  }

  const uniqueDescriptors = sourceDescriptor.refId === targetDescriptor.refId
    ? [sourceDescriptor]
    : [sourceDescriptor, targetDescriptor];
  const tokens = [];
  try {
    for (const descriptor of uniqueDescriptors) {
      tokens.push(await registry.bindAction(descriptor.refId, {
        expectedScope: scope,
        lease: normalizedLease,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      }));
    }
    const identities = await revalidateUniqueTokens(tokens, scope, normalizedLease, registry);
    const memberIdentities = sourceDescriptor.refId === targetDescriptor.refId
      ? [identities[0], identities[0]]
      : identities;
    assertPairIdentity(memberIdentities[0], memberIdentities[1]);
    const routes = await resolvePairRoutes(memberIdentities, resolveRoute);
    assertPairRoute(routes[0], routes[1]);

    // Route resolution may await host state. Revalidate the registry contexts
    // afterwards so a navigation or lease revocation cannot cross binding.
    const finalIdentities = await revalidateUniqueTokens(tokens, scope, normalizedLease, registry);
    const finalMembers = sourceDescriptor.refId === targetDescriptor.refId
      ? [finalIdentities[0], finalIdentities[0]]
      : finalIdentities;
    assertIdentityUnchanged(memberIdentities[0], finalMembers[0]);
    assertIdentityUnchanged(memberIdentities[1], finalMembers[1]);
    const finalRoutes = await resolvePairRoutes(finalMembers, resolveRoute);
    assertRouteUnchanged(routes[0], finalRoutes[0]);
    assertRouteUnchanged(routes[1], finalRoutes[1]);
    assertPairRoute(finalRoutes[0], finalRoutes[1]);

    return new DesktopReferencePair({
      kind,
      scope,
      lease: normalizedLease,
      tokens,
      source: finalMembers[0],
      target: finalMembers[1],
      sourceRoute: routeFingerprint(finalRoutes[0]),
      targetRoute: routeFingerprint(finalRoutes[1]),
      registry,
      resolveRoute,
    });
  } catch (error) {
    releaseTokens(registry, tokens);
    throw error;
  }
}

export async function revalidateReferencePair(pair, { expectedScope, lease, registry, resolveRoute } = {}) {
  const state = pairState(pair);
  assertLive(state);
  if (registry && registry !== state.registry) throw new TypeError("Reference pair registry cannot be replaced");
  if (resolveRoute && resolveRoute !== state.resolveRoute) throw new TypeError("Reference pair route resolver cannot be replaced");
  const activeRegistry = state.registry;
  const activeResolver = state.resolveRoute;
  assertDependencies(activeRegistry, activeResolver);
  const scope = normalizePageScope(expectedScope || state.scope);
  const normalizedLease = normalizeLease(lease || state.lease, scope.taskId);
  try {
    assertScopeAndLease(state, scope, normalizedLease);
    const unique = await revalidateUniqueTokens(state.tokens, scope, normalizedLease, activeRegistry);
    const members = state.tokens.length === 1 ? [unique[0], unique[0]] : unique;
    assertIdentityUnchanged(state.source, members[0]);
    assertIdentityUnchanged(state.target, members[1]);
    assertPairIdentity(members[0], members[1]);
    const routes = await resolvePairRoutes(members, activeResolver);
    assertRouteUnchanged(state.sourceRoute, routes[0]);
    assertRouteUnchanged(state.targetRoute, routes[1]);
    assertPairRoute(routes[0], routes[1]);
    return projectReferencePair(pair);
  } catch (error) {
    releaseReferencePair(pair);
    throw error;
  }
}

export function assertReferencePairCurrent(pair, { expectedScope, lease, registry, resolveRoute } = {}) {
  const state = pairState(pair);
  assertLive(state);
  if (registry && registry !== state.registry) throw new TypeError("Reference pair registry cannot be replaced");
  if (resolveRoute && resolveRoute !== state.resolveRoute) throw new TypeError("Reference pair route resolver cannot be replaced");
  const activeRegistry = state.registry;
  const activeResolver = state.resolveRoute;
  assertDependencies(activeRegistry, activeResolver);
  if (typeof activeRegistry.assertBoundActionCurrent !== "function") {
    throw new TypeError("registry.assertBoundActionCurrent must be a function");
  }
  const scope = normalizePageScope(expectedScope || state.scope);
  const normalizedLease = normalizeLease(lease || state.lease, scope.taskId);
  try {
    assertScopeAndLease(state, scope, normalizedLease);
    const unique = state.tokens.map((token) => activeRegistry.assertBoundActionCurrent(token, {
      expectedScope: scope,
      lease: normalizedLease,
    }));
    const members = state.tokens.length === 1 ? [unique[0], unique[0]] : unique;
    assertIdentityUnchanged(state.source, members[0]);
    assertIdentityUnchanged(state.target, members[1]);
    assertPairIdentity(members[0], members[1]);
    const routes = members.map((identity) => {
      const route = activeResolver(identity);
      if (route && typeof route.then === "function") {
        throw new TypeError("resolveRoute must return synchronously during final assertion");
      }
      return route;
    });
    assertRouteUnchanged(state.sourceRoute, routes[0]);
    assertRouteUnchanged(state.targetRoute, routes[1]);
    assertPairRoute(routes[0], routes[1]);
    return projectReferencePair(pair);
  } catch (error) {
    releaseReferencePair(pair);
    throw error;
  }
}

export function releaseReferencePair(pair) {
  const state = pairState(pair);
  if (state.released) return false;
  state.released = true;
  releaseTokens(state.registry, state.tokens);
  state.tokens.length = 0;
  return true;
}

export function projectReferencePair(pair) {
  const state = pairState(pair);
  return Object.freeze({
    kind: state.kind,
    runtimeId: state.source.runtimeId,
    pageId: state.source.pageId,
    frameId: state.source.frameId,
    documentId: state.source.documentId,
    documentEpoch: state.source.documentEpoch,
    source: publicMember(state.source),
    target: publicMember(state.target),
  });
}

class DesktopReferencePair {
  #state;

  constructor(state) {
    this.#state = {
      ...state,
      tokens: [...state.tokens],
      released: false,
    };
    Object.freeze(this);
  }

  [INTERNAL]() {
    return this.#state;
  }

  toJSON() {
    return projectReferencePair(this);
  }
}

async function revalidateUniqueTokens(tokens, expectedScope, lease, registry) {
  const identities = [];
  for (const token of tokens) {
    identities.push(await registry.revalidateBoundAction(token, { expectedScope, lease }));
  }
  return identities;
}

function resolvePairRoutes(identities, resolveRoute) {
  return identities.map((identity) => {
    const route = resolveRoute(identity);
    if (route && typeof route.then === "function") {
      throw new TypeError("resolveRoute must return synchronously");
    }
    return normalizeRoute(route, identity);
  });
}

function normalizeRoute(route, identity) {
  if (!route || typeof route !== "object") throw pairError("REFERENCE_PAIR_ROUTE_MISMATCH", "Pair member has no live route");
  if (route.identity) assertIdentityUnchanged(identity, route.identity);
  return Object.freeze({
    nativeSessionKey: nonEmptyString(route.nativeSessionKey, "route.nativeSessionKey"),
    nativeSessionGeneration: nonNegativeSafeInteger(route.nativeSessionGeneration, "route.nativeSessionGeneration"),
  });
}

function assertPairIdentity(source, target) {
  for (const key of ["runtimeId", "taskId", "pageId", "frameId", "documentId", "documentEpoch"]) {
    if (source[key] !== target[key]) {
      throw pairError("REFERENCE_PAIR_SCOPE_MISMATCH", `Drag endpoints differ in ${key}`);
    }
  }
}

function assertPairRoute(source, target) {
  if (source.nativeSessionKey !== target.nativeSessionKey
    || source.nativeSessionGeneration !== target.nativeSessionGeneration) {
    throw pairError("REFERENCE_PAIR_ROUTE_MISMATCH", "Drag endpoints do not share one live native session generation");
  }
}

function assertIdentityUnchanged(expected, actual) {
  for (const key of ["runtimeId", "taskId", "pageId", "frameId", "documentId", "documentEpoch", "refId", "backendNodeId"]) {
    if (expected[key] !== actual?.[key]) {
      throw pairError("REFERENCE_PAIR_STALE", `Pair member identity changed at ${key}`);
    }
  }
}

function assertRouteUnchanged(expected, actual) {
  const normalized = normalizeRoute(actual, actual?.identity || {});
  if (expected.nativeSessionKey !== normalized.nativeSessionKey
    || expected.nativeSessionGeneration !== normalized.nativeSessionGeneration) {
    throw pairError("REFERENCE_PAIR_ROUTE_MISMATCH", "Pair native route changed");
  }
}

function routeFingerprint(route) {
  return Object.freeze({
    nativeSessionKey: route.nativeSessionKey,
    nativeSessionGeneration: route.nativeSessionGeneration,
  });
}

function publicMember(identity) {
  return Object.freeze({
    refId: identity.refId,
    backendNodeId: identity.backendNodeId,
  });
}

function pairState(pair) {
  if (!pair || typeof pair[INTERNAL] !== "function") throw new TypeError("A bound reference pair is required");
  return pair[INTERNAL]();
}

function assertLive(state) {
  if (state.released) throw pairError("REFERENCE_PAIR_RELEASED", "Reference pair has been released");
}

function assertScopeAndLease(state, scope, lease) {
  if (pageKey(state.scope) !== pageKey(scope) || leaseKey(state.lease) !== leaseKey(lease)) {
    throw pairError("REFERENCE_PAIR_SCOPE_MISMATCH", "Reference pair caller page or lease changed");
  }
}

function releaseTokens(registry, tokens) {
  for (const token of new Set(tokens)) registry.releaseBoundAction(token);
}

function assertDependencies(registry, resolveRoute) {
  for (const method of ["bindAction", "revalidateBoundAction", "releaseBoundAction"]) {
    if (typeof registry?.[method] !== "function") throw new TypeError(`registry.${method} must be a function`);
  }
  if (typeof resolveRoute !== "function") throw new TypeError("resolveRoute must be a function");
}

function normalizeDescriptor(value, name) {
  if (!value || typeof value !== "object") throw new TypeError(`${name} descriptor must be an object`);
  return Object.freeze({
    refId: positiveSafeInteger(value.refId, `${name}.refId`),
    runtimeId: nonEmptyString(value.runtimeId, `${name}.runtimeId`),
  });
}

function normalizePageScope(scope) {
  if (!scope || typeof scope !== "object") throw new TypeError("expectedScope must be an object");
  return Object.freeze({
    runtimeId: nonEmptyString(scope.runtimeId, "expectedScope.runtimeId"),
    taskId: nonEmptyString(scope.taskId, "expectedScope.taskId"),
    pageId: nonEmptyString(scope.pageId, "expectedScope.pageId"),
  });
}

function normalizeLease(lease, taskId) {
  if (!lease || typeof lease !== "object") throw new TypeError("lease must be an object");
  const normalized = Object.freeze({
    taskId: nonEmptyString(lease.taskId, "lease.taskId"),
    taskSpaceId: positiveSafeInteger(lease.taskSpaceId, "lease.taskSpaceId"),
    clientId: nonEmptyString(lease.clientId, "lease.clientId"),
    leaseEpoch: nonNegativeSafeInteger(lease.leaseEpoch, "lease.leaseEpoch"),
  });
  if (normalized.taskId !== taskId) throw pairError("REFERENCE_PAIR_SCOPE_MISMATCH", "Lease task does not match expected scope");
  return normalized;
}

function pageKey(value) {
  return JSON.stringify([value.runtimeId, value.taskId, value.pageId]);
}

function leaseKey(value) {
  return JSON.stringify([value.taskId, value.taskSpaceId, value.clientId, value.leaseEpoch]);
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

function pairError(code, message, options) {
  return new DesktopReferencePairError(code, message, options);
}
