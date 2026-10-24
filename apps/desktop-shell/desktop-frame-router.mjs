const PAGE_SCOPED_EVENTS = new Set([
  "Browser.downloadProgress",
  "Browser.downloadWillBegin",
  "Page.javascriptDialogClosed",
  "Page.javascriptDialogOpening",
]);

const SOURCE_PREFERRED_PAGE_EVENTS = new Set([
  "Page.javascriptDialogClosed",
  "Page.javascriptDialogOpening",
]);

export class DesktopFrameRouterError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DesktopFrameRouterError";
    this.code = code;
  }
}

export class DesktopFrameRouter {
  #nativeSend;
  #createId;
  #now;
  #pageScopedEvents;
  #pages = new Map();
  #pageByWebContents = new Map();
  #effects = [];

  constructor(options = {}) {
    if (typeof options.nativeSend !== "function") {
      throw new TypeError("DesktopFrameRouter requires a nativeSend callback");
    }
    if (typeof options.createId !== "function") {
      throw new TypeError("DesktopFrameRouter requires a createId callback");
    }
    this.#nativeSend = options.nativeSend;
    this.#createId = options.createId;
    this.#now = options.now || Date.now;
    if (typeof this.#now !== "function") throw new TypeError("now must be a function");
    this.#pageScopedEvents = new Set(options.pageScopedEvents || PAGE_SCOPED_EVENTS);
  }

  // Integration must call this only from trusted desktop tab creation with
  // ownership resolved from the internal task, profile, and webContents record.
  registerPage(input) {
    const pageScope = normalizePageScope(input);
    const key = pageKey(pageScope);
    if (this.#pages.has(key)) throw routerError("PAGE_ALREADY_REGISTERED", "Page is already registered");
    const webContentsId = positiveSafeInteger(input?.webContentsId, "webContentsId");
    const ownershipKey = `${pageScope.runtimeId}\u0000${webContentsId}`;
    if (this.#pageByWebContents.has(ownershipKey)) {
      throw routerError("WEBCONTENTS_ALREADY_OWNED", "WebContents already belongs to a registered page");
    }
    const rootTargetId = nonEmptyString(input?.rootTargetId, "rootTargetId");
    const rootFrameId = nonEmptyString(input?.rootFrameId, "rootFrameId");
    const rootSessionKey = this.#newId("nativeSession");
    const page = {
      ...pageScope,
      incarnationId: this.#newId("pageIncarnation"),
      profileId: nonEmptyString(input?.profileId, "profileId"),
      webContentsId,
      rootTargetId,
      rootFrameId,
      rootSessionKey,
      generation: 0,
      state: "live",
      frames: new Map(),
      sessions: new Map(),
      sessionByElectronId: new Map(),
      sessionByTargetId: new Map(),
      aliases: new Map(),
      aliasByClientSession: new Map(),
      pending: new Map(),
    };
    const rootSession = {
      key: rootSessionKey,
      electronSessionId: undefined,
      targetId: rootTargetId,
      parentKey: undefined,
      frameId: rootFrameId,
      generation: 0,
      state: "live",
      attachedAt: this.#now(),
      metadata: {},
    };
    page.sessions.set(rootSessionKey, rootSession);
    page.sessionByTargetId.set(rootTargetId, rootSessionKey);
    const rootFrame = this.#newFrame(page, {
      frameId: rootFrameId,
      parentFrameId: undefined,
      nativeSessionKey: rootSessionKey,
      targetId: rootTargetId,
      transportState: "root",
    });
    rootSession.frameId = rootFrame.frameId;
    this.#pages.set(key, page);
    this.#pageByWebContents.set(ownershipKey, key);
    return freezePageRecord(page);
  }

  replacePage(input, reason = "page_replaced") {
    const pageScope = normalizePageScope(input);
    const key = pageKey(pageScope);
    const previous = this.#pages.get(key);
    if (!previous) throw routerError("UNKNOWN_PAGE", "Page must be registered and closed before replacement");
    if (previous.state !== "closed") throw routerError("PAGE_ALREADY_REGISTERED", "A live page cannot be replaced");
    const normalizedReason = nonEmptyString(reason, "reason");
    const previousOwnershipKey = `${previous.runtimeId}\u0000${previous.webContentsId}`;
    if (this.#pageByWebContents.get(previousOwnershipKey) === key) this.#pageByWebContents.delete(previousOwnershipKey);
    this.#pages.delete(key);
    const replacement = this.registerPage(input);
    this.#emit({
      type: "page_replaced",
      pageScope: normalizedFrozenPageScope(replacement),
      previousIncarnationId: previous.incarnationId,
      incarnationId: replacement.incarnationId,
      previousWebContentsId: previous.webContentsId,
      webContentsId: replacement.webContentsId,
      reason: normalizedReason,
    });
    return replacement;
  }

  closePage(pageScope, reason = "page_closed") {
    const page = this.#page(pageScope);
    const start = this.#effects.length;
    if (page.state === "closed") return [];
    page.state = "closed";
    page.generation += 1;
    const identities = [...page.frames.values()].filter(isLiveFrame).map(frameIdentity);
    if (identities.length) this.#emit({ type: "invalidate_documents", identities, reason });
    this.#cancelPending(page, () => true, reason);
    for (const alias of page.aliases.values()) alias.state = "retired";
    for (const session of page.sessions.values()) session.state = "detached";
    this.#emit({ type: "invalidate_page", pageScope: normalizedFrozenPageScope(page), reason });
    return this.#newEffects(start);
  }

  applyDebuggerEvent(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const start = this.#effects.length;
    const method = nonEmptyString(input?.method, "method");
    const params = input?.params && typeof input.params === "object" ? input.params : {};
    const source = this.#nativeSession(page, input?.sourceElectronSessionId);
    if (input?.expectedNativeSessionKey !== undefined || input?.expectedNativeSessionGeneration !== undefined) {
      const expectedKey = nonEmptyString(input.expectedNativeSessionKey, "expectedNativeSessionKey");
      const expectedGeneration = nonNegativeSafeInteger(input.expectedNativeSessionGeneration, "expectedNativeSessionGeneration");
      if (source.key !== expectedKey || source.generation !== expectedGeneration) {
        throw routerError("STALE_SESSION_ROUTE", "Debugger event native session changed during frame discovery");
      }
    }

    switch (method) {
      case "Target.attachedToTarget":
        this.#attachedToTarget(page, source, params);
        break;
      case "Target.targetInfoChanged":
        this.#targetInfoChanged(page, params);
        break;
      case "Target.detachedFromTarget":
        this.#detachedFromTarget(page, source, params);
        break;
      case "Page.frameAttached":
        this.#frameAttached(page, source, params);
        break;
      case "Page.frameNavigated":
        this.#frameNavigated(page, source, params);
        break;
      case "Page.navigatedWithinDocument":
        this.#navigatedWithinDocument(page, source, params);
        break;
      case "Page.frameDetached":
        this.#frameDetached(page, source, params);
        break;
      case "Runtime.executionContextCreated":
        this.#executionContextCreated(page, source, params);
        break;
      case "Runtime.executionContextDestroyed":
        this.#executionContextDestroyed(page, source, params);
        break;
      case "Runtime.executionContextsCleared":
        this.#executionContextsCleared(page, source);
        break;
      default:
        break;
    }
    return this.#newEffects(start);
  }

  captureNativeSession(pageScope, sourceElectronSessionId) {
    const page = this.#page(pageScope);
    this.#assertPageLive(page);
    const session = this.#nativeSession(page, sourceElectronSessionId);
    return Object.freeze({
      ...nativeRoute(page, session),
      nativeSessionGeneration: session.generation,
      frameId: session.frameId,
      parentNativeSessionKey: session.parentKey,
    });
  }

  attachClient(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const clientId = nonEmptyString(input?.clientId, "clientId");
    const targetId = nonEmptyString(input?.targetId, "targetId");
    const nativeSessionKey = page.sessionByTargetId.get(targetId);
    const session = nativeSessionKey ? page.sessions.get(nativeSessionKey) : undefined;
    if (!session || session.state !== "live") {
      throw routerError("UNKNOWN_TARGET", "Target has no live native session in this page");
    }
    const clientSessionKey = `${clientId}\u0000${session.key}`;
    const existingAlias = page.aliasByClientSession.get(clientSessionKey);
    const existing = existingAlias ? page.aliases.get(existingAlias) : undefined;
    if (existing?.state === "live") return freezeClientSession(page, existing, session);

    const alias = this.#newId("sessionAlias");
    const record = {
      alias,
      clientId,
      taskId: page.taskId,
      nativeSessionKey: session.key,
      attachedAt: this.#now(),
      state: "live",
    };
    page.aliases.set(alias, record);
    page.aliasByClientSession.set(clientSessionKey, alias);
    return freezeClientSession(page, record, session);
  }

  detachClient(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const start = this.#effects.length;
    const clientId = nonEmptyString(input?.clientId, "clientId");
    const alias = nonEmptyString(input?.alias, "alias");
    const record = page.aliases.get(alias);
    if (!record || record.state !== "live") throw routerError("UNKNOWN_ALIAS", "Client session alias is unknown or retired");
    if (record.clientId !== clientId || record.taskId !== page.taskId) {
      throw routerError("FOREIGN_ALIAS", "Client session alias belongs to another client or task");
    }
    this.#retireAlias(page, record, "client_detach");
    this.#cancelPending(page, (pending) => pending.alias === alias, "client_detach");
    return this.#newEffects(start);
  }

  resolveCommand(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const clientId = nonEmptyString(input?.clientId, "clientId");
    const alias = nonEmptyString(input?.alias, "alias");
    const record = page.aliases.get(alias);
    if (!record || record.state !== "live") throw routerError("UNKNOWN_ALIAS", "Client session alias is unknown or retired");
    if (record.clientId !== clientId || record.taskId !== page.taskId) {
      throw routerError("FOREIGN_ALIAS", "Client session alias belongs to another client or task");
    }
    const session = page.sessions.get(record.nativeSessionKey);
    if (!session || session.state !== "live") throw routerError("DETACHED_SESSION", "Native session is detached");
    const frame = session.frameId ? page.frames.get(session.frameId) : undefined;
    if (!frame || !isLiveFrame(frame)) throw routerError("FRAME_UNRESOLVED", "Native session is not bound to a live frame");
    if (input.expectedIdentity) assertIdentityMatches(frame, input.expectedIdentity);
    return freezeCommandRoute(page, session, frame, alias, clientId);
  }

  resolveFrameCommand(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const frameId = nonEmptyString(input?.frameId || input?.expectedIdentity?.frameId, "frameId");
    const frame = page.frames.get(frameId);
    if (!frame || !isLiveFrame(frame)) throw routerError("DETACHED_FRAME", "Frame is missing or detached");
    if (input.expectedIdentity) assertIdentityMatches(frame, input.expectedIdentity);
    const session = page.sessions.get(frame.nativeSessionKey);
    if (!session || session.state !== "live") throw routerError("DETACHED_SESSION", "Frame native session is detached");
    if (frame.transportState === "swapping") throw routerError("FRAME_SWAPPING", "Frame transport is changing process");
    if (frame.defaultExecutionContextId === undefined) {
      throw routerError("FRAME_CONTEXT_UNAVAILABLE", "Frame has no current default execution context");
    }
    return freezeFrameRoute(page, session, frame);
  }

  listFrameRoutes(pageScope) {
    const page = this.#page(pageScope);
    this.#assertPageLive(page);
    const routes = [];
    const visited = new Set();
    const visit = (frame) => {
      if (!frame || visited.has(frame.frameId) || !isLiveFrame(frame)) return;
      visited.add(frame.frameId);
      const session = page.sessions.get(frame.nativeSessionKey);
      if (session?.state === "live" && frame.transportState !== "swapping"
        && frame.defaultExecutionContextId !== undefined) {
        routes.push(freezeFrameRoute(page, session, frame));
      }
      for (const child of page.frames.values()) {
        if (child.parentFrameId === frame.frameId) visit(child);
      }
    };
    visit(page.frames.get(page.rootFrameId));
    for (const frame of page.frames.values()) visit(frame);
    return Object.freeze(routes);
  }

  async sendFrameCommand(input, method, params = {}) {
    if (!input?.expectedIdentity) throw new TypeError("expectedIdentity is required");
    const expectedNativeSessionGeneration = nonNegativeSafeInteger(
      input.expectedNativeSessionGeneration,
      "expectedNativeSessionGeneration",
    );
    const route = this.resolveFrameCommand({
      pageScope: input.pageScope,
      frameId: input.expectedIdentity.frameId,
      expectedIdentity: input.expectedIdentity,
    });
    if (route.nativeSessionGeneration !== expectedNativeSessionGeneration) {
      throw routerError("STALE_SESSION_ROUTE", "Native session generation changed before command dispatch");
    }
    return this.#send({
      runtimeId: route.runtimeId,
      taskId: route.taskId,
      pageId: route.pageId,
      webContentsId: route.webContentsId,
      nativeSessionKey: route.nativeSessionKey,
      electronSessionId: route.electronSessionId,
    }, nonEmptyString(method, "method"), normalizeCommandParams(params));
  }

  routeNativeEvent(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const source = this.#nativeSession(page, input?.sourceElectronSessionId);
    const method = nonEmptyString(input?.method, "method");
    const params = input?.params && typeof input.params === "object" ? input.params : {};
    const scope = input?.scope || (this.#pageScopedEvents.has(method) ? "page" : "session");
    if (scope !== "page" && scope !== "session") throw new TypeError("Event scope must be page or session");

    const recipients = [];
    if (scope === "session") {
      for (const alias of page.aliases.values()) {
        if (alias.state === "live" && alias.nativeSessionKey === source.key) recipients.push(alias);
      }
    } else {
      const clients = new Set([...page.aliases.values()].filter((alias) => alias.state === "live").map((alias) => alias.clientId));
      for (const clientId of clients) {
        const sourceAliasId = page.aliasByClientSession.get(`${clientId}\u0000${source.key}`);
        const sourceAlias = sourceAliasId ? page.aliases.get(sourceAliasId) : undefined;
        const rootAliasId = page.aliasByClientSession.get(`${clientId}\u0000${page.rootSessionKey}`);
        const rootAlias = rootAliasId ? page.aliases.get(rootAliasId) : undefined;
        const canonical = SOURCE_PREFERRED_PAGE_EVENTS.has(method) && sourceAlias?.state === "live"
          ? sourceAlias
          : rootAlias?.state === "live"
            ? rootAlias
            : [...page.aliases.values()].find((alias) => alias.state === "live" && alias.clientId === clientId);
        if (canonical) recipients.push(canonical);
      }
    }
    const sourceFrame = source.frameId ? page.frames.get(source.frameId) : undefined;
    const reportedFrame = typeof params.frameId === "string" ? page.frames.get(params.frameId) : undefined;
    const originFrame = reportedFrame && isLiveFrame(reportedFrame) ? reportedFrame : sourceFrame;
    const origin = Object.freeze({
      runtimeId: page.runtimeId,
      taskId: page.taskId,
      pageId: page.pageId,
      ...(originFrame ? { frameId: originFrame.frameId, identity: frameIdentity(originFrame) } : {}),
      targetId: originFrame?.targetId || source.targetId,
      nativeSessionKey: source.key,
      ...(sourceFrame ? { sourceFrameId: sourceFrame.frameId } : {}),
      sourceTargetId: source.targetId,
    });
    return Object.freeze(recipients.map((alias) => Object.freeze({
      taskId: page.taskId,
      clientId: alias.clientId,
      alias: alias.alias,
      method,
      params,
      origin,
    })));
  }

  beginPending(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const clientId = nonEmptyString(input?.clientId, "clientId");
    const alias = input?.alias === undefined ? undefined : nonEmptyString(input.alias, "alias");
    let nativeSessionKey;
    let frameId;
    if (alias) {
      const route = this.resolveCommand({ pageScope: input.pageScope, clientId, alias });
      nativeSessionKey = route.nativeSessionKey;
      frameId = route.identity.frameId;
    } else if (input?.frameId) {
      const route = this.resolveFrameCommand({ pageScope: input.pageScope, frameId: input.frameId });
      nativeSessionKey = route.nativeSessionKey;
      frameId = route.identity.frameId;
    }
    const pendingId = this.#newId("pending");
    page.pending.set(pendingId, {
      pendingId,
      clientId,
      alias,
      nativeSessionKey,
      frameId,
      startedAt: this.#now(),
    });
    return pendingId;
  }

  finishPending(pageScope, pendingId) {
    const page = this.#page(pageScope);
    return page.pending.delete(nonEmptyString(pendingId, "pendingId"));
  }

  async captureFrameIdentity(input) {
    const page = this.#page(input?.pageScope);
    this.#assertPageLive(page);
    const frame = this.#liveFrame(page, input?.frameId);
    await this.#verifyNativeDocument(page, frame, { allowRotate: true });
    const session = page.sessions.get(frame.nativeSessionKey);
    if (!session || session.state !== "live") throw routerError("DETACHED_SESSION", "Frame native session is detached");
    return Object.freeze({
      identity: frameIdentity(frame),
      pageIncarnationId: page.incarnationId,
      pageGeneration: page.generation,
      nativeSessionGeneration: session.generation,
      nativeSessionKey: session.key,
      defaultExecutionContextUniqueId: frame.defaultExecutionContextUniqueId,
      loaderId: frame.loaderId,
      verifiedDocumentBackendNodeId: frame.verifiedDocumentBackendNodeId,
    });
  }

  async validateFrameIdentity(stamp) {
    if (!stamp || typeof stamp !== "object" || !stamp.identity) throw new TypeError("Frame identity stamp is required");
    const page = this.#page(stamp.identity);
    this.#assertPageLive(page);
    const frame = this.#liveFrame(page, stamp.identity.frameId);
    const session = page.sessions.get(frame.nativeSessionKey);
    if (!session || session.state !== "live") throw routerError("DETACHED_SESSION", "Frame native session is detached");
    if (page.incarnationId !== stamp.pageIncarnationId || page.generation !== stamp.pageGeneration || session.key !== stamp.nativeSessionKey
      || session.generation !== stamp.nativeSessionGeneration) {
      throw routerError("STALE_DOCUMENT", "Frame transport changed during the operation");
    }
    assertIdentityMatches(frame, stamp.identity);
    await this.#verifyNativeDocument(page, frame, { allowRotate: false });
    if (frame.defaultExecutionContextUniqueId !== stamp.defaultExecutionContextUniqueId
      || frame.loaderId !== stamp.loaderId
      || frame.verifiedDocumentBackendNodeId !== stamp.verifiedDocumentBackendNodeId) {
      throw routerError("STALE_DOCUMENT", "Native document changed during the operation");
    }
    return frameIdentity(frame);
  }

  observedFrameIdentity(pageScope, frameId) {
    const page = this.#page(pageScope);
    return frameIdentity(this.#liveFrame(page, frameId));
  }

  isCurrentDocument(identity) {
    try {
      const page = this.#page(identity);
      if (page.state !== "live") return false;
      const frame = page.frames.get(nonEmptyString(identity?.frameId, "frameId"));
      return Boolean(frame && isLiveFrame(frame) && identityMatches(frame, identity));
    } catch {
      return false;
    }
  }

  invalidateDocuments(identities, reason = "document_invalidated") {
    if (!Array.isArray(identities)) throw new TypeError("identities must be an array");
    const start = this.#effects.length;
    for (const identity of identities) {
      const page = this.#page(identity);
      const frame = page.frames.get(nonEmptyString(identity.frameId, "frameId"));
      if (frame && isLiveFrame(frame) && identityMatches(frame, identity)) this.#rotateDocument(page, frame, reason);
    }
    return this.#newEffects(start);
  }

  invalidateFrameSubtree(pageScope, frameIds, reason = "frame_subtree_invalidated") {
    const page = this.#page(pageScope);
    if (!Array.isArray(frameIds)) throw new TypeError("frameIds must be an array");
    const start = this.#effects.length;
    const roots = frameIds.map((frameId) => nonEmptyString(frameId, "frameId"));
    const subtree = this.#frameSubtree(page, roots);
    this.#invalidateFrames(page, subtree, reason);
    return this.#newEffects(start);
  }

  invalidatePage(pageScope, reason = "page_invalidated") {
    return this.closePage(pageScope, reason);
  }

  takeEffects() {
    return Object.freeze(this.#effects.splice(0));
  }

  stats(pageScope) {
    const page = this.#page(pageScope);
    return Object.freeze({
      frames: [...page.frames.values()].filter(isLiveFrame).length,
      nativeSessions: [...page.sessions.values()].filter((session) => session.state === "live").length,
      clientAliases: [...page.aliases.values()].filter((alias) => alias.state === "live").length,
      pending: page.pending.size,
      pageGeneration: page.generation,
      state: page.state,
    });
  }

  #attachedToTarget(page, source, params) {
    const electronSessionId = nonEmptyString(params?.sessionId, "params.sessionId");
    if (page.sessionByElectronId.has(electronSessionId)) return;
    const info = params?.targetInfo;
    if (!info || info.type !== "iframe") {
      throw routerError("UNSUPPORTED_TARGET", "Only iframe child targets belong to the desktop frame router");
    }
    const targetId = nonEmptyString(info.targetId, "targetInfo.targetId");
    const existingKey = page.sessionByTargetId.get(targetId);
    const existing = existingKey ? page.sessions.get(existingKey) : undefined;
    if (existing?.state === "live") throw routerError("TARGET_ALREADY_ATTACHED", "Target already has a live native session");
    const key = this.#newId("nativeSession");
    const session = {
      key,
      electronSessionId,
      targetId,
      parentKey: source.key,
      frameId: undefined,
      generation: 0,
      state: "live",
      attachedAt: this.#now(),
      metadata: {
        title: typeof info.title === "string" ? info.title : "",
        url: typeof info.url === "string" ? info.url : "",
      },
    };
    page.sessions.set(key, session);
    page.sessionByElectronId.set(electronSessionId, key);
    page.sessionByTargetId.set(targetId, key);
    this.#emit({
      type: "configure_native_session",
      pageScope: normalizedFrozenPageScope(page),
      nativeSessionKey: key,
      nativeSessionGeneration: session.generation,
      electronSessionId,
      parentNativeSessionKey: source.key,
      targetId,
    });
  }

  #targetInfoChanged(page, params) {
    const info = params?.targetInfo;
    if (!info?.targetId) return;
    const key = page.sessionByTargetId.get(info.targetId);
    const session = key ? page.sessions.get(key) : undefined;
    if (!session || session.state !== "live") return;
    session.metadata = {
      ...session.metadata,
      title: typeof info.title === "string" ? info.title : session.metadata.title,
      url: typeof info.url === "string" ? info.url : session.metadata.url,
    };
  }

  #detachedFromTarget(page, source, params) {
    const electronSessionId = nonEmptyString(params?.sessionId, "params.sessionId");
    const key = page.sessionByElectronId.get(electronSessionId);
    const session = key ? page.sessions.get(key) : undefined;
    if (!session || session.state !== "live") throw routerError("FOREIGN_SESSION", "Detached session is unknown in this page");
    if (session.parentKey !== source.key) throw routerError("FOREIGN_SESSION", "Detach event came from the wrong parent session");
    this.#invalidateSessionSubtree(page, session.key, "native_session_detached");
  }

  #frameAttached(page, source, params) {
    const frameId = nonEmptyString(params?.frameId, "params.frameId");
    const parentFrameId = nonEmptyString(params?.parentFrameId, "params.parentFrameId");
    this.#assertFramePlacement(page, source, frameId, parentFrameId);
    if (!page.frames.has(frameId) || !isLiveFrame(page.frames.get(frameId))) {
      this.#newFrame(page, {
        frameId,
        parentFrameId,
        nativeSessionKey: source.key,
        transportState: source.key === page.rootSessionKey ? "same_process" : "oopif",
      });
    }
  }

  #frameNavigated(page, source, params) {
    const details = params?.frame;
    const frameId = nonEmptyString(details?.id, "frame.id");
    let frame = page.frames.get(frameId);
    const parentFrameId = details?.parentId === undefined
      ? (frame && isLiveFrame(frame) ? frame.parentFrameId : undefined)
      : nonEmptyString(details.parentId, "frame.parentId");
    const parent = this.#assertFramePlacement(page, source, frameId, parentFrameId);
    if (!frame || !isLiveFrame(frame)) {
      frame = this.#newFrame(page, {
        frameId,
        parentFrameId,
        nativeSessionKey: source.key,
        targetId: source.targetId === page.rootTargetId ? undefined : source.targetId,
        transportState: source.key === page.rootSessionKey ? "same_process" : "oopif",
      });
    }
    const oldSessionKey = frame.nativeSessionKey;
    if (oldSessionKey !== source.key) {
      const oldSession = page.sessions.get(oldSessionKey);
      if (oldSession?.frameId === frame.frameId) oldSession.frameId = undefined;
      frame.nativeSessionKey = source.key;
      frame.targetId = source.targetId === page.rootTargetId ? frame.targetId : source.targetId;
      frame.transportState = source.key === page.rootSessionKey ? "same_process" : "oopif";
      frame.defaultExecutionContextId = undefined;
      frame.defaultExecutionContextUniqueId = undefined;
      source.generation += 1;
    }
    if (frameId === page.rootFrameId || (source.key !== page.rootSessionKey && parent?.nativeSessionKey === source.parentKey)) {
      source.frameId = frameId;
    }
    frame.parentFrameId = parentFrameId;
    frame.url = typeof details.url === "string" ? details.url : frame.url;
    const loaderId = typeof details.loaderId === "string" && details.loaderId ? details.loaderId : undefined;
    if (loaderId && frame.loaderId && loaderId !== frame.loaderId) {
      this.#rotateDocument(page, frame, "cross_document_navigation");
      frame.defaultExecutionContextId = undefined;
      frame.defaultExecutionContextUniqueId = undefined;
    }
    if (loaderId) frame.loaderId = loaderId;
  }

  #assertFramePlacement(page, source, frameId, parentFrameId) {
    if (frameId === page.rootFrameId) {
      if (source.key !== page.rootSessionKey) throw routerError("FOREIGN_SESSION", "A child session cannot own the page root frame");
      if (parentFrameId !== undefined) throw routerError("FOREIGN_FRAME", "Page root frame cannot have a parent");
      return undefined;
    }
    const parent = parentFrameId === undefined ? undefined : page.frames.get(parentFrameId);
    if (!parent || !isLiveFrame(parent)) throw routerError("FOREIGN_FRAME", "Frame parent is unknown in this page");
    if (this.#frameSubtree(page, [frameId]).includes(parent.frameId)) {
      throw routerError("FOREIGN_FRAME", "Frame parent would create a cycle");
    }
    if (source.key === parent.nativeSessionKey) return parent;
    if (source.parentKey !== parent.nativeSessionKey || (source.frameId !== undefined && source.frameId !== frameId)) {
      throw routerError("FOREIGN_SESSION", "Frame event came from a session outside its trusted parent route");
    }
    return parent;
  }

  #navigatedWithinDocument(page, source, params) {
    const frameId = nonEmptyString(params?.frameId, "params.frameId");
    const frame = page.frames.get(frameId);
    if (!frame || !isLiveFrame(frame)) throw routerError("FOREIGN_FRAME", "Same-document navigation belongs to an unknown frame");
    if (frame.nativeSessionKey !== source.key) throw routerError("FOREIGN_SESSION", "Same-document navigation came from the wrong session");
    if (typeof params.url === "string") frame.url = params.url;
  }

  #frameDetached(page, source, params) {
    const frameId = nonEmptyString(params?.frameId, "params.frameId");
    const frame = page.frames.get(frameId);
    if (!frame || !isLiveFrame(frame)) return;
    this.#assertFramePlacement(page, source, frameId, frame.parentFrameId);
    const reason = params?.reason === "swap" ? "swap" : "remove";
    if (reason === "swap") {
      // Chromium can report the old-process swap after the child session has
      // already navigated and rebound the logical frame. Do not roll that
      // newer binding back into a swapping state.
      if (frame.nativeSessionKey === source.key) frame.transportState = "swapping";
      return;
    }
    const subtree = this.#frameSubtree(page, [frameId]);
    this.#invalidateFrames(page, subtree, "frame_removed");
  }

  #executionContextCreated(page, source, params) {
    const context = params?.context;
    if (!context?.auxData?.isDefault) return;
    const frameId = nonEmptyString(context.auxData.frameId, "context.auxData.frameId");
    const frame = page.frames.get(frameId);
    if (!frame || !isLiveFrame(frame)) throw routerError("FOREIGN_FRAME", "Execution context belongs to an unknown frame");
    if (frame.nativeSessionKey !== source.key) {
      throw routerError("FOREIGN_SESSION", "Execution context came from the wrong native session");
    }
    const contextId = nonNegativeSafeInteger(context.id, "context.id");
    const uniqueId = nonEmptyString(context.uniqueId, "context.uniqueId");
    if (frame.defaultExecutionContextUniqueId
      && frame.defaultExecutionContextUniqueId !== uniqueId
      && frame.transportState !== "swapping") {
      this.#rotateDocument(page, frame, "execution_context_changed");
    }
    frame.defaultExecutionContextId = contextId;
    frame.defaultExecutionContextUniqueId = uniqueId;
    if (frame.transportState === "swapping") {
      frame.transportState = source.key === page.rootSessionKey ? "same_process" : "oopif";
    }
  }

  #executionContextDestroyed(page, source, params) {
    const contextId = nonNegativeSafeInteger(params?.executionContextId, "params.executionContextId");
    for (const frame of page.frames.values()) {
      if (isLiveFrame(frame) && frame.nativeSessionKey === source.key && frame.defaultExecutionContextId === contextId) {
        frame.defaultExecutionContextId = undefined;
      }
    }
  }

  #executionContextsCleared(page, source) {
    for (const frame of page.frames.values()) {
      if (isLiveFrame(frame) && frame.nativeSessionKey === source.key) {
        frame.defaultExecutionContextId = undefined;
      }
    }
  }

  async #verifyNativeDocument(page, frame, { allowRotate }) {
    if (frame.transportState === "swapping") throw routerError("FRAME_SWAPPING", "Frame transport is changing process");
    if (frame.defaultExecutionContextId === undefined) {
      throw routerError("FRAME_CONTEXT_UNAVAILABLE", "Frame has no current default execution context");
    }
    const session = page.sessions.get(frame.nativeSessionKey);
    if (!session || session.state !== "live") throw routerError("DETACHED_SESSION", "Frame native session is detached");
    const route = nativeRoute(page, session);
    const frameTree = await this.#send(route, "Page.getFrameTree", {});
    const nativeFrame = findFrame(frameTree?.frameTree, frame.frameId);
    if (!nativeFrame) throw routerError("NATIVE_DOCUMENT_UNAVAILABLE", "Native frame tree no longer contains the frame");
    const nativeLoaderId = typeof nativeFrame.loaderId === "string" && nativeFrame.loaderId ? nativeFrame.loaderId : undefined;
    if (nativeLoaderId && frame.loaderId && nativeLoaderId !== frame.loaderId) {
      this.#rotateDocument(page, frame, "native_loader_changed");
      frame.loaderId = nativeLoaderId;
      frame.defaultExecutionContextId = undefined;
      frame.defaultExecutionContextUniqueId = undefined;
      if (!allowRotate) throw routerError("STALE_DOCUMENT", "Native loader changed during the operation");
      throw routerError("FRAME_CONTEXT_UNAVAILABLE", "Native loader changed before a new default context was observed");
    } else if (nativeLoaderId) {
      frame.loaderId = nativeLoaderId;
    }

    let objectId;
    try {
      const evaluated = await this.#send(route, "Runtime.evaluate", {
        expression: "document",
        contextId: frame.defaultExecutionContextId,
        returnByValue: false,
      });
      objectId = evaluated?.result?.objectId;
      if (!objectId) throw routerError("NATIVE_DOCUMENT_UNAVAILABLE", "Native document evaluation returned no object");
      const described = await this.#send(route, "DOM.describeNode", { objectId });
      const backendNodeId = positiveSafeInteger(described?.node?.backendNodeId, "node.backendNodeId");
      if (frame.verifiedDocumentBackendNodeId !== undefined
        && frame.verifiedDocumentBackendNodeId !== backendNodeId) {
        this.#rotateDocument(page, frame, "native_document_changed");
        frame.verifiedDocumentBackendNodeId = backendNodeId;
        frame.defaultExecutionContextId = undefined;
        frame.defaultExecutionContextUniqueId = undefined;
        if (!allowRotate) throw routerError("STALE_DOCUMENT", "Native document changed during the operation");
        throw routerError("FRAME_CONTEXT_UNAVAILABLE", "Native document changed before a new default context was observed");
      } else {
        frame.verifiedDocumentBackendNodeId = backendNodeId;
      }
    } catch (error) {
      if (error instanceof DesktopFrameRouterError) throw error;
      throw routerError("NATIVE_DOCUMENT_UNAVAILABLE", "Native document verification failed", { cause: error });
    } finally {
      if (objectId) await this.#send(route, "Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  async #send(route, method, params) {
    return this.#nativeSend(Object.freeze({ ...route, method, params }));
  }

  #newFrame(page, input) {
    const frame = {
      runtimeId: page.runtimeId,
      taskId: page.taskId,
      pageId: page.pageId,
      frameId: nonEmptyString(input.frameId, "frameId"),
      parentFrameId: input.parentFrameId,
      documentId: this.#newId("document"),
      documentEpoch: 0,
      loaderId: undefined,
      defaultExecutionContextId: undefined,
      defaultExecutionContextUniqueId: undefined,
      verifiedDocumentBackendNodeId: undefined,
      nativeSessionKey: input.nativeSessionKey,
      targetId: input.targetId,
      transportState: input.transportState,
      state: "live",
      url: "",
    };
    page.frames.set(frame.frameId, frame);
    return frame;
  }

  #rotateDocument(page, frame, reason) {
    const oldIdentity = frameIdentity(frame);
    frame.documentEpoch += 1;
    frame.documentId = this.#newId("document");
    frame.verifiedDocumentBackendNodeId = undefined;
    this.#emit({ type: "invalidate_documents", identities: [oldIdentity], reason });
    this.#cancelPending(page, (pending) => pending.frameId === frame.frameId, reason);
  }

  #invalidateFrames(page, frameIds, reason) {
    const identities = [];
    for (const frameId of frameIds) {
      const frame = page.frames.get(frameId);
      if (!frame || !isLiveFrame(frame)) continue;
      identities.push(frameIdentity(frame));
      frame.state = "detached";
      frame.transportState = "detached";
      frame.defaultExecutionContextId = undefined;
      frame.defaultExecutionContextUniqueId = undefined;
    }
    if (identities.length) {
      this.#emit({ type: "invalidate_frame_subtree", pageScope: normalizedFrozenPageScope(page), frameIds: [...frameIds], identities, reason });
      this.#cancelPending(page, (pending) => frameIds.includes(pending.frameId), reason);
    }
  }

  #invalidateSessionSubtree(page, rootSessionKey, reason) {
    const sessionKeys = [];
    const visit = (key) => {
      sessionKeys.push(key);
      for (const session of page.sessions.values()) {
        if (session.state === "live" && session.parentKey === key) visit(session.key);
      }
    };
    visit(rootSessionKey);
    const frames = [];
    for (const key of sessionKeys) {
      const session = page.sessions.get(key);
      if (!session || session.state !== "live") continue;
      session.state = "detached";
      session.generation += 1;
      if (session.electronSessionId) page.sessionByElectronId.delete(session.electronSessionId);
      if (page.sessionByTargetId.get(session.targetId) === key) page.sessionByTargetId.delete(session.targetId);
      if (session.frameId) frames.push(...this.#frameSubtree(page, [session.frameId]));
      for (const alias of page.aliases.values()) {
        if (alias.state === "live" && alias.nativeSessionKey === key) this.#retireAlias(page, alias, reason);
      }
    }
    this.#invalidateFrames(page, [...new Set(frames)], reason);
    this.#cancelPending(page, (pending) => sessionKeys.includes(pending.nativeSessionKey), reason);
    this.#emit({ type: "native_sessions_detached", nativeSessionKeys: sessionKeys, reason });
  }

  #retireAlias(page, alias, reason) {
    alias.state = "retired";
    const key = `${alias.clientId}\u0000${alias.nativeSessionKey}`;
    if (page.aliasByClientSession.get(key) === alias.alias) page.aliasByClientSession.delete(key);
    this.#emit({ type: "alias_retired", taskId: page.taskId, clientId: alias.clientId, alias: alias.alias, reason });
  }

  #cancelPending(page, predicate, reason) {
    const pendingIds = [];
    for (const [pendingId, pending] of page.pending) {
      if (!predicate(pending)) continue;
      page.pending.delete(pendingId);
      pendingIds.push(pendingId);
    }
    if (pendingIds.length) this.#emit({ type: "cancel_pending", pendingIds, reason });
  }

  #frameSubtree(page, rootFrameIds) {
    const selected = new Set(rootFrameIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const frame of page.frames.values()) {
        if (isLiveFrame(frame) && frame.parentFrameId && selected.has(frame.parentFrameId) && !selected.has(frame.frameId)) {
          selected.add(frame.frameId);
          changed = true;
        }
      }
    }
    return [...selected];
  }

  #nativeSession(page, electronSessionId) {
    if (electronSessionId === undefined || electronSessionId === null || electronSessionId === "") {
      const root = page.sessions.get(page.rootSessionKey);
      if (!root || root.state !== "live") throw routerError("DETACHED_SESSION", "Root native session is detached");
      return root;
    }
    const key = page.sessionByElectronId.get(nonEmptyString(electronSessionId, "sourceElectronSessionId"));
    const session = key ? page.sessions.get(key) : undefined;
    if (!session || session.state !== "live") throw routerError("FOREIGN_SESSION", "Native session is foreign, unknown, or detached");
    return session;
  }

  #liveFrame(page, frameId) {
    const normalized = nonEmptyString(frameId, "frameId");
    const frame = page.frames.get(normalized);
    if (!frame || !isLiveFrame(frame)) throw routerError("DETACHED_FRAME", "Frame is missing or detached");
    return frame;
  }

  #page(scope) {
    const normalized = normalizePageScope(scope);
    const page = this.#pages.get(pageKey(normalized));
    if (!page) throw routerError("UNKNOWN_PAGE", "Page is not registered for this runtime, task, and page scope");
    return page;
  }

  #assertPageLive(page) {
    if (page.state !== "live") throw routerError("PAGE_CLOSED", "Page is closed");
  }

  #emit(effect) {
    this.#effects.push(deepFreeze(effect));
  }

  #newEffects(start) {
    return Object.freeze(this.#effects.slice(start));
  }

  #newId(kind) {
    return nonEmptyString(this.#createId(kind), `${kind} id`);
  }
}

function normalizePageScope(scope) {
  if (!scope || typeof scope !== "object") throw new TypeError("Page scope must be an object");
  return {
    runtimeId: nonEmptyString(scope.runtimeId, "runtimeId"),
    taskId: nonEmptyString(scope.taskId, "taskId"),
    pageId: nonEmptyString(scope.pageId, "pageId"),
  };
}

function normalizedFrozenPageScope(scope) {
  return Object.freeze({ runtimeId: scope.runtimeId, taskId: scope.taskId, pageId: scope.pageId });
}

function pageKey(scope) {
  return JSON.stringify([scope.runtimeId, scope.taskId, scope.pageId]);
}

function frameIdentity(frame) {
  return Object.freeze({
    runtimeId: frame.runtimeId,
    taskId: frame.taskId,
    pageId: frame.pageId,
    frameId: frame.frameId,
    documentId: frame.documentId,
    documentEpoch: frame.documentEpoch,
  });
}

function identityMatches(frame, expected) {
  const current = frameIdentity(frame);
  return Object.keys(current).every((key) => current[key] === expected?.[key]);
}

function assertIdentityMatches(frame, expected) {
  if (!identityMatches(frame, expected)) throw routerError("STALE_DOCUMENT", "Expected frame document identity is no longer current");
}

function nativeRoute(page, session) {
  return Object.freeze({
    runtimeId: page.runtimeId,
    taskId: page.taskId,
    pageId: page.pageId,
    pageIncarnationId: page.incarnationId,
    webContentsId: page.webContentsId,
    nativeSessionKey: session.key,
    electronSessionId: session.electronSessionId,
  });
}

function freezePageRecord(page) {
  return Object.freeze({
    ...normalizedFrozenPageScope(page),
    profileId: page.profileId,
    webContentsId: page.webContentsId,
    rootTargetId: page.rootTargetId,
    rootFrameId: page.rootFrameId,
    incarnationId: page.incarnationId,
    pageGeneration: page.generation,
    state: page.state,
  });
}

function freezeClientSession(page, alias, session) {
  return Object.freeze({
    taskId: page.taskId,
    clientId: alias.clientId,
    alias: alias.alias,
    targetId: session.targetId,
  });
}

function freezeCommandRoute(page, session, frame, alias, clientId) {
  return Object.freeze({
    ...nativeRoute(page, session),
    clientId,
    alias,
    executionContextId: frame.defaultExecutionContextId,
    identity: frameIdentity(frame),
    nativeSessionGeneration: session.generation,
  });
}

function freezeFrameRoute(page, session, frame) {
  return Object.freeze({
    ...nativeRoute(page, session),
    parentFrameId: frame.parentFrameId,
    targetId: frame.targetId || session.targetId,
    transportState: frame.transportState,
    executionContextId: frame.defaultExecutionContextId,
    executionContextUniqueId: frame.defaultExecutionContextUniqueId,
    identity: frameIdentity(frame),
    nativeSessionGeneration: session.generation,
  });
}

function normalizeCommandParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("Command params must be an object");
  }
  return params;
}

function findFrame(tree, frameId) {
  if (!tree) return undefined;
  if (tree.frame?.id === frameId) return tree.frame;
  for (const child of tree.childFrames || []) {
    const found = findFrame(child, frameId);
    if (found) return found;
  }
  return undefined;
}

function isLiveFrame(frame) {
  return frame.state === "live";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function routerError(code, message, options) {
  return new DesktopFrameRouterError(code, message, options);
}
