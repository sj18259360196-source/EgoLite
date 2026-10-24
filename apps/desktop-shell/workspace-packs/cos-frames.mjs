import { randomUUID } from "node:crypto";

// Frame IDs are local to this tab. Documents rotate on navigation, not on reads.
export class CosFrames {
  constructor(contents, command, check, dispose) {
    this.contents = contents;
    this.command = command;
    this.check = check;
    this.dispose = dispose;
    this.frames = new Map();
    this.sessions = new Map();
    this.contexts = new Map();
    this.nextId = 1;
    this.listener = (_event, method, params, session = "") => {
      if (method === "Runtime.executionContextCreated" && params.context.auxData?.isDefault) {
        this.contexts.set(`${session}:${params.context.auxData.frameId}`, params.context.id);
      }
      if (method === "Runtime.executionContextsCleared") {
        for (const key of this.contexts.keys()) if (key.startsWith(`${session}:`)) this.contexts.delete(key);
      }
      if (method === "Runtime.executionContextDestroyed") {
        for (const [key, id] of this.contexts) if (key.startsWith(`${session}:`) && id === params.executionContextId) this.contexts.delete(key);
      }
      if (method === "Target.detachedFromTarget") {
        for (const [id, value] of this.sessions) if (value === params.sessionId) this.sessions.delete(id);
      }
    };
    contents.debugger.on("message", this.listener);
  }

  async refresh() {
    this.check();
    const { frameTree } = await this.command("Page.getFrameTree");
    const found = new Set();
    const visit = node => {
      const data = node.frame;
      found.add(data.id);
      let frame = this.frames.get(data.id);
      if (!frame || frame.loaderId !== data.loaderId) {
        frame = { id: data.id, frameId: data.id === frameTree.frame.id ? 0 : frame?.frameId ?? this.nextId++,
          loaderId: data.loaderId, documentId: randomUUID() };
        this.frames.set(data.id, frame);
      }
      for (const child of node.childFrames || []) visit(child);
    };
    visit(frameTree);
    // Chromium omits out-of-process children from Page.getFrameTree. Frame-owner
    // nodes prove membership before attaching to those renderer targets.
    const scan = async session => {
      const { root } = await this.command("DOM.getDocument", { depth: -1, pierce: true }, session);
      const ids = new Set();
      const walk = node => {
        if (["IFRAME", "FRAME"].includes(node.nodeName) && node.frameId) ids.add(node.frameId);
        for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) walk(child);
      };
      walk(root);
      for (const id of ids) {
        if (found.has(id)) continue;
        let childSession = this.sessions.get(id);
        if (!childSession) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const { targetInfos } = await this.command("Target.getTargets");
              if (!targetInfos.some(target => target.type === "iframe" && target.targetId === id)) {
                throw new Error("No target with given id found");
              }
              childSession = (await this.command("Target.attachToTarget", { targetId: id, flatten: true })).sessionId;
              break;
            } catch (error) {
              if (attempt === 2 || !/No target with given id/.test(error.message)) throw error;
              await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
              this.check();
            }
          }
          this.sessions.set(id, childSession);
          await this.command("Runtime.enable", {}, childSession);
          await this.command("Page.enable", {}, childSession);
        }
        const childTree = await this.command("Page.getFrameTree", {}, childSession);
        visit(childTree.frameTree);
        await scan(childSession);
      }
    };
    await scan();
    for (const id of this.frames.keys()) if (!found.has(id)) this.frames.delete(id);
    for (const [id, sessionId] of this.sessions) if (!found.has(id)) {
      await this.command("Target.detachFromTarget", { sessionId }).catch(() => {});
      this.sessions.delete(id);
    }
    this.check();
    return [...this.frames.values()].sort((a, b) => a.frameId - b.frameId);
  }

  async current(frame) {
    await this.refresh();
    if (this.frames.get(frame.id) !== frame) throw new Error("CoS requested frame document is stale");
  }

  async context(frame) {
    let session = this.sessions.get(frame.id);
    const create = () => this.command("Page.createIsolatedWorld", { frameId: frame.id, worldName: "ego-cos-frame" }, session);
    try { return { ...(await create()), session }; }
    catch (error) {
      if (session || !/frame/i.test(error.message)) throw error;
      await this.current(frame);
      // Only a frame proven to belong to this tab may be attached as an OOPIF.
      const attached = await this.command("Target.attachToTarget", { targetId: frame.id, flatten: true });
      session = attached.sessionId;
      this.sessions.set(frame.id, session);
      await this.command("Runtime.enable", {}, session);
      await this.command("Page.enable", {}, session);
      return { ...(await create()), session };
    }
  }

  async execute(frame, expression, world) {
    await this.current(frame);
    const context = await this.context(frame);
    const contextId = world === "MAIN" ? this.contexts.get(`${context.session || ""}:${frame.id}`) : context.executionContextId;
    if (!contextId) throw new Error("CoS main frame execution context is unavailable");
    await this.current(frame);
    const result = await this.command("Runtime.evaluate", { contextId, expression, awaitPromise: true, returnByValue: true }, context.session);
    await this.current(frame);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return { frameId: frame.frameId, documentId: frame.documentId, result: result.result?.value };
  }

  async insertCSS(frame, text) {
    await this.current(frame);
    const { session } = await this.context(frame);
    await this.command("DOM.enable", {}, session);
    await this.command("CSS.enable", {}, session);
    await this.current(frame);
    const { styleSheetId } = await this.command("CSS.createStyleSheet", { frameId: frame.id }, session);
    await this.current(frame);
    await this.command("CSS.setStyleSheetText", { styleSheetId, text }, session);
    await this.current(frame);
  }

  async stop() {
    this.contents.debugger.removeListener("message", this.listener);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.frames.clear();
    this.contexts.clear();
    if (this.dispose) await this.dispose(sessions);
    else for (const sessionId of sessions) await this.contents.debugger.sendCommand("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

export function validateScriptTarget(target) {
  const { allFrames, frameIds, documentIds } = target;
  if (allFrames && (frameIds !== undefined || documentIds !== undefined) || frameIds !== undefined && documentIds !== undefined) {
    throw new Error("CoS script target selectors are mutually exclusive");
  }
  if (frameIds !== undefined && (!Array.isArray(frameIds) || !frameIds.length || frameIds.some(id => !Number.isInteger(id) || id < 0))) {
    throw new Error("CoS script requires valid frame IDs");
  }
  if (documentIds !== undefined && (!Array.isArray(documentIds) || !documentIds.length || documentIds.some(id => typeof id !== "string" || !id))) {
    throw new Error("CoS script requires valid document IDs");
  }
}
