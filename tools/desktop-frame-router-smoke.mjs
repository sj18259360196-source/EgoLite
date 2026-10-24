import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(toolPath), "..");

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function parseArgs(argv) {
  const parsed = {
    outputDir: join(projectRoot, "output", "p1-implementation-20260916"),
    tempDir: join(projectRoot, ".tmp", "codex", "p1-implementation-20260916", "transport-real"),
    timeoutMs: 60_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") parsed.outputDir = resolve(argv[++index]);
    else if (arg === "--temp-dir") parsed.tempDir = resolve(argv[++index]);
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!isAbsolute(parsed.outputDir) || !isAbsolute(parsed.tempDir)) throw new Error("Output and temp directories must be absolute");
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 10_000 || parsed.timeoutMs > 180_000) {
    throw new Error("timeout-ms must be between 10000 and 180000");
  }
  return parsed;
}

function fixturePage(body, extra = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}button,input{font-size:18px;padding:10px;margin:10px}iframe{display:block;width:700px;height:360px;border:4px solid #345;margin:20px}.spacer{height:850px}</style>${extra}</head><body>${body}</body></html>`;
}

async function runParent() {
  const options = parseArgs(process.argv.slice(2));
  const runTemp = join(options.tempDir, `run-${process.pid}-${randomUUID()}`);
  const tempRelative = relative(resolve(options.tempDir), resolve(runTemp));
  if (!tempRelative || tempRelative.startsWith("..") || isAbsolute(tempRelative)) throw new Error("Unsafe smoke temp path");
  await mkdir(runTemp, { recursive: true });
  await mkdir(options.outputDir, { recursive: true });
  await rm(join(options.outputDir, "desktop-frame-router-smoke.json"), { force: true });
  await rm(join(options.outputDir, "desktop-frame-router-smoke-error.txt"), { force: true });

  let port;
  const server = createServer((request, response) => {
    const host = request.headers.host || "";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/") {
      response.end(fixturePage(`
        <button id="root-action">Shared Label</button>
        <div class="spacer"></div>
        <div id="frames"></div>
        <pre id="root-state">ready</pre>
      `));
      return;
    }
    if (request.url?.startsWith("/same")) {
      response.end(fixturePage(`<button id="same-action">Shared Label</button><input id="same-input"><script>globalThis.fixtureState={clicks:[]};document.querySelector('#same-action').addEventListener('click',event=>fixtureState.clicks.push({id:event.target.id,isTrusted:event.isTrusted,clientX:event.clientX,clientY:event.clientY}));document.body.dataset.page='same'</script>`));
      return;
    }
    if (request.url?.startsWith("/cross2") && host.startsWith("cross.test")) {
      response.end(fixturePage(`<button id="cross2-action">Cross Two</button><script>document.body.dataset.page='cross2'</script>`));
      return;
    }
    if (request.url?.startsWith("/cross") && host.startsWith("cross.test")) {
      response.end(fixturePage(`
        <button id="cross-action">Shared Label</button>
        <button id="dialog-action">Open Dialog</button>
        <input id="cross-input">
        <div id="nested-slot"></div>
        <script>
          globalThis.fixtureState={dialogs:0,clicks:[]};
          document.querySelector('#cross-action').addEventListener('click',event=>fixtureState.clicks.push({id:event.target.id,isTrusted:event.isTrusted,clientX:event.clientX,clientY:event.clientY}));
          document.querySelector('#dialog-action').addEventListener('click',()=>{fixtureState.dialogs+=1;alert('child-dialog')});
          setTimeout(()=>{const frame=document.createElement('iframe');frame.id='nested';frame.src='http://root.test:${port}/nested';document.querySelector('#nested-slot').append(frame)},300);
          document.body.dataset.page='cross';
        </script>
      `));
      return;
    }
    if (request.url?.startsWith("/nested") && host.startsWith("root.test")) {
      response.end(fixturePage(`<button id="nested-action">Nested Action</button><script>document.body.dataset.page='nested'</script>`));
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });

  const closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));
  let child;
  let timeout;
  const logChunks = [];
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolveListen();
      });
    });
    const electronExecutable = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
    child = spawn(electronExecutable, [join(projectRoot, "tools", "desktop-frame-router-smoke-app.mjs")], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TEMP: runTemp,
        TMP: runTemp,
        FRAME_ROUTER_SMOKE_OUTPUT: options.outputDir,
        FRAME_ROUTER_SMOKE_ROOT_URL: `http://root.test:${port}/`,
        FRAME_ROUTER_SMOKE_CROSS_URL: `http://cross.test:${port}/cross`,
        FRAME_ROUTER_SMOKE_PORT: String(port),
      },
    });
    child.stdout.on("data", (chunk) => logChunks.push(`stdout ${chunk}`));
    child.stderr.on("data", (chunk) => logChunks.push(`stderr ${chunk}`));
    const exit = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
      timeout = setTimeout(() => rejectExit(new Error(`Electron frame-router smoke timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    });
    if (exit.code !== 0) throw new Error(`Electron frame-router smoke failed ${JSON.stringify(exit)}`);
    const evidencePath = join(options.outputDir, "desktop-frame-router-smoke.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.status, "passed");
    console.log(`desktop-frame-router smoke passed with ${evidence.assertions.length} assertions`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child && child.exitCode === null) child.kill();
    await closeServer().catch(() => {});
    await writeFile(join(options.outputDir, "desktop-frame-router-smoke.log"), logChunks.join(""), "utf8").catch(() => {});
    await rm(runTemp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runElectronChild({ app, BrowserWindow }) {
  const { DesktopFrameRouter } = await import("../apps/desktop-shell/desktop-frame-router.mjs");
  const { DesktopReferenceRegistry } = await import("../apps/desktop-shell/desktop-reference-registry.mjs");
  console.error(`[frame-router-smoke] child-run ready=${app.isReady()}`);

  const outputDir = process.env.FRAME_ROUTER_SMOKE_OUTPUT;
  const rootUrl = process.env.FRAME_ROUTER_SMOKE_ROOT_URL;
  const crossUrl = process.env.FRAME_ROUTER_SMOKE_CROSS_URL;
  if (!outputDir || !rootUrl || !crossUrl) throw new Error("Missing frame-router smoke child environment");

  const assertions = [];
  const rawEvents = [];
  const effects = [];
  const routedDialogs = [];
  const dialogHandles = [];
  const observations = {
    sessions: new Map(),
    framesByUrl: new Map(),
    frameSessions: new Map(),
    detachedFrames: [],
  };
  const recordAssertion = (name, details = {}) => assertions.push({ name, ...details });
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const webContents = win.webContents;
  const debuggerApi = webContents.debugger;
  let router;
  let eventChain = Promise.resolve();
  let fatalEventError;

  const directSend = (method, params = {}, electronSessionId) => electronSessionId
    ? debuggerApi.sendCommand(method, params, electronSessionId)
    : debuggerApi.sendCommand(method, params);
  const nativeSend = ({ method, params, electronSessionId }) => directSend(method, params, electronSessionId);
  const withDeadline = (promise, label, timeoutMs = 5_000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);

  const autoAttachParams = {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: false,
    filter: [
      { type: "iframe", exclude: false },
      { exclude: true },
    ],
  };

  const configureSession = async (electronSessionId) => {
    await withDeadline(directSend("Page.enable", {}, electronSessionId), `Page.enable ${electronSessionId || "root"}`);
    await withDeadline(directSend("Runtime.enable", {}, electronSessionId), `Runtime.enable ${electronSessionId || "root"}`);
    await withDeadline(directSend("DOM.enable", {}, electronSessionId), `DOM.enable ${electronSessionId || "root"}`);
    await withDeadline(directSend("Target.setAutoAttach", autoAttachParams, electronSessionId), `Target.setAutoAttach ${electronSessionId || "root"}`);
  };

  const consumeEffects = async () => {
    for (const effect of router.takeEffects()) {
      effects.push(JSON.parse(JSON.stringify(effect)));
      if (effect.type === "configure_native_session") await configureSession(effect.electronSessionId);
    }
  };

  const compactEvent = (method, params, sourceElectronSessionId) => ({
    at: Date.now(),
    method,
    sourceElectronSessionId: sourceElectronSessionId || null,
    params,
  });

  const observeEvent = (method, params, sourceElectronSessionId) => {
    if (method === "Target.attachedToTarget") {
      observations.sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        parentSessionId: sourceElectronSessionId || null,
        targetId: params.targetInfo?.targetId,
        initialUrl: params.targetInfo?.url || "",
      });
    }
    if (method === "Page.frameNavigated") {
      const frame = params.frame;
      observations.framesByUrl.set(frame.url, frame.id);
      observations.frameSessions.set(frame.id, sourceElectronSessionId || null);
    }
    if (method === "Page.navigatedWithinDocument") observations.framesByUrl.set(params.url, params.frameId);
    if (method === "Page.frameDetached") observations.detachedFrames.push({ frameId: params.frameId, reason: params.reason, sourceElectronSessionId: sourceElectronSessionId || null });
  };

  const handleEvent = async (method, params, sourceElectronSessionId) => {
    observeEvent(method, params, sourceElectronSessionId);
    if (method.startsWith("Target.") || method.startsWith("Page.frame") || method === "Page.navigatedWithinDocument"
      || method.startsWith("Page.javascriptDialog")
      || method.startsWith("Runtime.executionContext")) {
      rawEvents.push(compactEvent(method, params, sourceElectronSessionId));
    }
    router.applyDebuggerEvent({
      pageScope: { runtimeId: "runtime-smoke", taskId: "task-smoke", pageId: "page-smoke" },
      sourceElectronSessionId,
      method,
      params,
    });
    await consumeEffects();
    if (method === "Page.javascriptDialogOpening") {
      const routed = router.routeNativeEvent({
        pageScope: { runtimeId: "runtime-smoke", taskId: "task-smoke", pageId: "page-smoke" },
        sourceElectronSessionId,
        method,
        params,
      });
      routedDialogs.push(...routed.map((event) => JSON.parse(JSON.stringify(event))));
      await directSend("Page.handleJavaScriptDialog", { accept: true }, sourceElectronSessionId);
      dialogHandles.push({
        accepted: true,
        sourceElectronSessionId: sourceElectronSessionId || null,
        routedAliases: routed.map((event) => ({ clientId: event.clientId, alias: event.alias })),
      });
    }
  };

  const onMessage = (_event, method, params, sourceElectronSessionId) => {
    eventChain = eventChain.then(() => handleEvent(method, params || {}, sourceElectronSessionId)).catch((error) => {
      fatalEventError ||= error;
    });
  };
  debuggerApi.on("message", onMessage);

  const settleEvents = async () => {
    await eventChain;
    if (fatalEventError) throw fatalEventError;
  };
  const waitFor = async (predicate, label, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      await settleEvents();
      try {
        last = await predicate();
        if (last) return last;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(40);
    }
    throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  };
  const evaluate = async (expression, electronSessionId, contextId) => {
    const response = await directSend("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    }, electronSessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  const quadCenter = (quad) => ({
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  });

  let completed = false;
  try {
    await webContents.loadURL(rootUrl);
    webContents.setZoomFactor(1.5);
    debuggerApi.attach("1.3");
    const [targetInfo, initialFrameTree] = await Promise.all([
      directSend("Target.getTargetInfo"),
      directSend("Page.getFrameTree"),
    ]);
    const rootTargetId = targetInfo.targetInfo.targetId;
    const rootFrameId = initialFrameTree.frameTree.frame.id;
    router = new DesktopFrameRouter({
      nativeSend,
      createId: (kind) => `${kind}-${randomUUID()}`,
      now: Date.now,
    });
    const pageScope = { runtimeId: "runtime-smoke", taskId: "task-smoke", pageId: "page-smoke" };
    router.registerPage({
      ...pageScope,
      profileId: "profile-smoke",
      webContentsId: webContents.id,
      rootTargetId,
      rootFrameId,
    });

    await directSend("Target.setDiscoverTargets", { discover: true });
    await configureSession(undefined);
    await settleEvents();
    await waitFor(() => {
      try {
        return router.resolveFrameCommand({ pageScope, frameId: rootFrameId });
      } catch {
        return undefined;
      }
    }, "root execution context");

    await evaluate(`(() => {
      const same=document.createElement('iframe');same.id='same';same.src='/same';
      const cross=document.createElement('iframe');cross.id='cross';cross.src=${JSON.stringify(crossUrl)};
      document.querySelector('#frames').append(same,cross);return true;
    })()`);

    const sameFrameId = await waitFor(() => [...observations.framesByUrl.entries()].find(([url]) => url.includes("/same"))?.[1], "same-origin frame");
    const crossFrameId = await waitFor(() => [...observations.framesByUrl.entries()].find(([url]) => /\/cross(?:$|#)/.test(new URL(url).pathname))?.[1], "cross OOPIF frame");
    const crossSessionId = await waitFor(() => observations.frameSessions.get(crossFrameId), "cross OOPIF session");
    const nestedFrameId = await waitFor(() => [...observations.framesByUrl.entries()].find(([url]) => url.includes("/nested"))?.[1], "nested OOPIF frame");
    const nestedSessionId = await waitFor(() => observations.frameSessions.get(nestedFrameId), "nested OOPIF session");

    const rootRoute = router.resolveFrameCommand({ pageScope, frameId: rootFrameId });
    const sameRoute = router.resolveFrameCommand({ pageScope, frameId: sameFrameId });
    const crossRoute = router.resolveFrameCommand({ pageScope, frameId: crossFrameId });
    const nestedRoute = router.resolveFrameCommand({ pageScope, frameId: nestedFrameId });
    assert.equal(rootRoute.electronSessionId, undefined);
    assert.equal(sameRoute.electronSessionId, undefined);
    assert.equal(crossRoute.electronSessionId, crossSessionId);
    assert.equal(nestedRoute.electronSessionId, nestedSessionId);
    const crossAttach = observations.sessions.get(crossSessionId);
    const nestedAttach = observations.sessions.get(nestedSessionId);
    assert.equal(crossAttach.initialUrl, "");
    assert.equal(nestedAttach.parentSessionId, crossSessionId);
    recordAssertion("real root SIF OOPIF and nested routes", {
      rootFrameId,
      sameFrameId,
      crossFrameId,
      nestedFrameId,
      crossSessionId,
      nestedSessionId,
    });

    const rootStamp = await router.captureFrameIdentity({ pageScope, frameId: rootFrameId });
    const sameStamp = await router.captureFrameIdentity({ pageScope, frameId: sameFrameId });
    const crossStamp = await router.captureFrameIdentity({ pageScope, frameId: crossFrameId });
    const nestedStamp = await router.captureFrameIdentity({ pageScope, frameId: nestedFrameId });
    await consumeEffects();
    for (const stamp of [rootStamp, sameStamp, crossStamp, nestedStamp]) {
      assert.deepEqual(await router.validateFrameIdentity(stamp), stamp.identity);
      await consumeEffects();
    }
    const listedRoutes = router.listFrameRoutes(pageScope);
    assert.deepEqual(listedRoutes.map((route) => route.identity.frameId), [rootFrameId, sameFrameId, crossFrameId, nestedFrameId]);
    const crossListedRoute = listedRoutes.find((route) => route.identity.frameId === crossFrameId);
    const routedCommand = await router.sendFrameCommand({
      pageScope,
      expectedIdentity: crossListedRoute.identity,
      expectedNativeSessionGeneration: crossListedRoute.nativeSessionGeneration,
    }, "Runtime.evaluate", {
      expression: "document.body.dataset.page",
      contextId: crossListedRoute.executionContextId,
      returnByValue: true,
    });
    assert.equal(routedCommand.result.value, "cross");
    recordAssertion("native document identity capture and validation", {
      identities: [rootStamp, sameStamp, crossStamp, nestedStamp].map((stamp) => stamp.identity),
      parentFirstFrameOrder: listedRoutes.map((route) => route.identity.frameId),
      routedCommandValue: routedCommand.result.value,
    });

    console.error("[frame-router-smoke] geometry-cross-start");
    const crossDocumentForGeometry = await directSend("DOM.getDocument", { depth: -1 }, crossSessionId);
    const crossButtonForGeometry = await directSend("DOM.querySelector", {
      nodeId: crossDocumentForGeometry.root.nodeId,
      selector: "#cross-action",
    }, crossSessionId);
    const crossButtonDescription = await directSend("DOM.describeNode", {
      nodeId: crossButtonForGeometry.nodeId,
    }, crossSessionId);
    const crossButtonBackendNodeId = crossButtonDescription.node.backendNodeId;
    const crossBeforeScroll = await evaluate(`(() => {const r=document.querySelector('#cross').getBoundingClientRect();return {scrollX,scrollY,innerHeight,owner:{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom}}})()`);
    let crossScrollError;
    try {
      await directSend("DOM.scrollIntoViewIfNeeded", { backendNodeId: crossButtonBackendNodeId }, crossSessionId);
    } catch (error) {
      crossScrollError = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
    const crossAfterScroll = await evaluate(`(() => {const r=document.querySelector('#cross').getBoundingClientRect();return {scrollX,scrollY,innerHeight,owner:{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom}}})()`);
    const crossBox = await directSend("DOM.getBoxModel", { backendNodeId: crossButtonBackendNodeId }, crossSessionId);
    const crossPoint = quadCenter(crossBox.model.content);
    let crossHit;
    let crossHitError;
    try {
      crossHit = await directSend("DOM.getNodeForLocation", {
        x: Math.round(crossPoint.x),
        y: Math.round(crossPoint.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      }, crossSessionId);
    } catch (error) {
      crossHitError = error instanceof Error ? error.message : String(error);
    }
    await directSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: crossPoint.x, y: crossPoint.y }, crossSessionId);
    await directSend("Input.dispatchMouseEvent", { type: "mousePressed", x: crossPoint.x, y: crossPoint.y, button: "left", clickCount: 1 }, crossSessionId);
    await directSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: crossPoint.x, y: crossPoint.y, button: "left", clickCount: 1 }, crossSessionId);
    let crossClickOutcome = null;
    for (let attempt = 0; attempt < 25 && !crossClickOutcome; attempt += 1) {
      crossClickOutcome = await evaluate(`globalThis.fixtureState.clicks[0] || null`, crossSessionId, crossRoute.executionContextId);
      if (!crossClickOutcome) await sleep(40);
    }
    const crossAncestorAutoScrolled = crossAfterScroll.scrollY !== crossBeforeScroll.scrollY
      && crossAfterScroll.owner.top < crossAfterScroll.innerHeight
      && crossAfterScroll.owner.bottom > 0;
    if (crossHit) {
      assert.equal(crossHit.backendNodeId, crossButtonBackendNodeId);
      assert.equal(crossHit.frameId, crossFrameId);
    }
    recordAssertion("OOPIF child-only scroll and local hit experiment", {
      before: crossBeforeScroll,
      after: crossAfterScroll,
      ancestorAutoScrolled: crossAncestorAutoScrolled,
      scrollError: crossScrollError,
      localBoxModel: crossBox.model,
      localPoint: crossPoint,
      hit: crossHit,
      hitError: crossHitError,
      clickOutcome: crossClickOutcome,
    });

    console.error("[frame-router-smoke] geometry-sif-start");
    const sameObject = await directSend("Runtime.evaluate", {
      expression: "document.querySelector('#same-action')",
      contextId: sameRoute.executionContextId,
      returnByValue: false,
    });
    const sameObjectId = sameObject.result?.objectId;
    assert.ok(sameObjectId);
    const sameDescription = await directSend("DOM.describeNode", { objectId: sameObjectId });
    const sameBackendNodeId = sameDescription.node.backendNodeId;
    const sameBeforeScroll = await evaluate(`(() => {const r=document.querySelector('#same').getBoundingClientRect();return {scrollX,scrollY,innerHeight,owner:{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom}}})()`);
    console.error("[frame-router-smoke] geometry-sif-scroll");
    await directSend("DOM.scrollIntoViewIfNeeded", { backendNodeId: sameBackendNodeId });
    await sleep(100);
    const sameAfterScroll = await evaluate(`(() => {const r=document.querySelector('#same').getBoundingClientRect();return {scrollX,scrollY,innerHeight,devicePixelRatio,owner:{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom}}})()`);
    const sameBox = await directSend("DOM.getBoxModel", { objectId: sameObjectId });
    const samePoint = quadCenter(sameBox.model.content);
    const sameViewportPoint = {
      x: samePoint.x - sameAfterScroll.scrollX,
      y: samePoint.y - sameAfterScroll.scrollY,
    };
    console.error("[frame-router-smoke] geometry-sif-hit");
    let sameRawHit;
    let sameRawHitError;
    try {
      sameRawHit = await directSend("DOM.getNodeForLocation", {
        x: Math.round(samePoint.x),
        y: Math.round(samePoint.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      });
    } catch (error) {
      sameRawHitError = error instanceof Error ? error.message : String(error);
    }
    let sameViewportHit;
    let sameViewportHitError;
    try {
      sameViewportHit = await directSend("DOM.getNodeForLocation", {
        x: Math.round(sameViewportPoint.x),
        y: Math.round(sameViewportPoint.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      });
    } catch (error) {
      sameViewportHitError = error instanceof Error ? error.message : String(error);
    }
    const sameDevicePoint = {
      x: samePoint.x * sameAfterScroll.devicePixelRatio,
      y: samePoint.y * sameAfterScroll.devicePixelRatio,
    };
    let sameDeviceHit;
    let sameDeviceHitError;
    try {
      sameDeviceHit = await directSend("DOM.getNodeForLocation", {
        x: Math.round(sameDevicePoint.x),
        y: Math.round(sameDevicePoint.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      });
    } catch (error) {
      sameDeviceHitError = error instanceof Error ? error.message : String(error);
    }
    const sameInputPoint = sameViewportHit?.backendNodeId === sameBackendNodeId ? sameViewportPoint : samePoint;
    const sameOwnerRect = await evaluate(`(() => {const r=document.querySelector('#same').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`);
    const sameLocalRect = await evaluate(`(() => {const r=document.querySelector('#same-action').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`, undefined, sameRoute.executionContextId);
    const sameLocalCenter = {
      x: sameLocalRect.left + sameLocalRect.width / 2,
      y: sameLocalRect.top + sameLocalRect.height / 2,
    };
    const sameLocalHit = await evaluate(`(() => {const button=document.querySelector('#same-action');const r=button.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {hitId:hit?.id||null,targetContainsHit:Boolean(hit&&button.contains(hit))}})()`, undefined, sameRoute.executionContextId);
    const sameComposedPoint = {
      x: sameOwnerRect.left + 4 + sameLocalCenter.x,
      y: sameOwnerRect.top + 4 + sameLocalCenter.y,
    };
    const sameComposedDelta = {
      x: samePoint.x - sameComposedPoint.x,
      y: samePoint.y - sameComposedPoint.y,
    };
    await directSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: sameInputPoint.x, y: sameInputPoint.y });
    await directSend("Input.dispatchMouseEvent", { type: "mousePressed", x: sameInputPoint.x, y: sameInputPoint.y, button: "left", clickCount: 1 });
    await directSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: sameInputPoint.x, y: sameInputPoint.y, button: "left", clickCount: 1 });
    const sameClickOutcome = await waitFor(() => evaluate(`globalThis.fixtureState.clicks.length ? globalThis.fixtureState.clicks[0] : null`, undefined, sameRoute.executionContextId), "trusted SIF click");
    await directSend("Runtime.releaseObject", { objectId: sameObjectId });
    assert.equal(sameClickOutcome.id, "same-action");
    assert.equal(sameClickOutcome.isTrusted, true);
    assert.equal(sameLocalHit.targetContainsHit, true);
    assert.ok(Math.abs(sameComposedDelta.x) < 0.01);
    assert.ok(Math.abs(sameComposedDelta.y) < 0.01);
    recordAssertion("SIF root-session box geometry produces trusted click", {
      before: sameBeforeScroll,
      after: sameAfterScroll,
      ownerRect: sameOwnerRect,
      localRect: sameLocalRect,
      localCenter: sameLocalCenter,
      localHit: sameLocalHit,
      composedRootPoint: sameComposedPoint,
      composedVsNativeDelta: sameComposedDelta,
      boxModel: sameBox.model,
      rawBoxPoint: samePoint,
      viewportPoint: sameViewportPoint,
      devicePoint: sameDevicePoint,
      dispatchedRootPoint: sameInputPoint,
      rawHit: sameRawHit,
      rawHitError: sameRawHitError,
      viewportHit: sameViewportHit,
      viewportHitError: sameViewportHitError,
      deviceHit: sameDeviceHit,
      deviceHitError: sameDeviceHitError,
      outcome: sameClickOutcome,
    });

    const rootAliasA = router.attachClient({ pageScope, clientId: "client-a", targetId: rootTargetId });
    const rootAliasARepeated = router.attachClient({ pageScope, clientId: "client-a", targetId: rootTargetId });
    const rootAliasB = router.attachClient({ pageScope, clientId: "client-b", targetId: rootTargetId });
    assert.equal(rootAliasA.alias, rootAliasARepeated.alias);
    assert.notEqual(rootAliasA.alias, rootAliasB.alias);
    assert.throws(() => router.resolveCommand({ pageScope, clientId: "client-b", alias: rootAliasA.alias }), { code: "FOREIGN_ALIAS" });
    router.detachClient({ pageScope, clientId: "client-a", alias: rootAliasA.alias });
    await consumeEffects();
    const rootAliasARotated = router.attachClient({ pageScope, clientId: "client-a", targetId: rootTargetId });
    assert.notEqual(rootAliasA.alias, rootAliasARotated.alias);
    assert.equal(router.resolveCommand({ pageScope, clientId: "client-b", alias: rootAliasB.alias }).taskId, "task-smoke");
    recordAssertion("client alias scope repeat and detach rotation", {
      firstAlias: rootAliasA.alias,
      repeatedAlias: rootAliasARepeated.alias,
      rotatedAlias: rootAliasARotated.alias,
      otherClientAlias: rootAliasB.alias,
    });

    const crossTargetId = observations.sessions.get(crossSessionId).targetId;
    const crossAliasA = router.attachClient({ pageScope, clientId: "client-a", targetId: crossTargetId });
    await evaluate(`setTimeout(()=>document.querySelector('#dialog-action').click(),0);true`, crossSessionId, crossRoute.executionContextId);
    await waitFor(() => routedDialogs.length >= 2, "routed child dialog");
    await sleep(100);
    await settleEvents();
    const dialogA = routedDialogs.find((event) => event.clientId === "client-a");
    const dialogB = routedDialogs.find((event) => event.clientId === "client-b");
    const openingEvent = rawEvents.find((event) => event.method === "Page.javascriptDialogOpening");
    assert.equal(openingEvent.sourceElectronSessionId, null);
    assert.equal(dialogA.alias, rootAliasARotated.alias);
    assert.equal(dialogA.origin.frameId, crossFrameId);
    assert.equal(dialogA.origin.sourceFrameId, rootFrameId);
    assert.equal(dialogB.alias, rootAliasB.alias);
    assert.equal(routedDialogs.filter((event) => event.clientId === "client-a").length, 1);
    assert.deepEqual(dialogHandles, [{
      accepted: true,
      sourceElectronSessionId: null,
      routedAliases: [
        { clientId: "client-b", alias: rootAliasB.alias },
        { clientId: "client-a", alias: rootAliasARotated.alias },
      ],
    }]);
    assert.match(openingEvent.params.url, /cross\.test/);
    recordAssertion("real OOPIF dialog is reported on Electron root session and routed once per client", {
      triggerFrameId: crossFrameId,
      triggerSessionId: crossSessionId,
      electronEventSourceSessionId: openingEvent.sourceElectronSessionId,
      dialogUrl: openingEvent.params.url,
      unusedChildAliasForSourceRouting: crossAliasA.alias,
      routedDialogs,
      dialogHandles,
    });

    let nextReferenceId = 50_000;
    const refs = new DesktopReferenceRegistry({
      allocator: { allocate: () => nextReferenceId++ },
      isCurrentDocument: (identity) => router.isCurrentDocument(identity),
      revalidateAction: async () => {},
    });
    const crossDocument = await directSend("DOM.getDocument", { depth: -1 }, crossSessionId);
    const crossButton = await directSend("DOM.querySelector", {
      nodeId: crossDocument.root.nodeId,
      selector: "#cross-action",
    }, crossSessionId);
    const describedButton = await directSend("DOM.describeNode", { nodeId: crossButton.nodeId }, crossSessionId);
    const snapshotTicket = refs.beginSnapshot(crossStamp.identity);
    const [oldReference] = refs.commitSnapshot(snapshotTicket, {
      mode: "partial",
      nodes: [{ backendNodeId: describedButton.node.backendNodeId }],
    });
    assert.equal(refs.resolve(oldReference.ref, pageScope).frameId, crossFrameId);

    await evaluate(`location.hash='stable';true`, crossSessionId, crossRoute.executionContextId);
    await waitFor(() => rawEvents.some((event) => event.method === "Page.navigatedWithinDocument"
      && event.params.frameId === crossFrameId && event.params.url.endsWith("#stable")), "same-document navigation");
    assert.equal(router.isCurrentDocument(crossStamp.identity), true);
    assert.deepEqual(await router.validateFrameIdentity(crossStamp), crossStamp.identity);
    await consumeEffects();
    recordAssertion("hash navigation preserves document identity", { identity: crossStamp.identity });

    await evaluate(`location.href='/cross2';true`, crossSessionId, crossRoute.executionContextId);
    await waitFor(() => {
      try {
        const identity = router.observedFrameIdentity(pageScope, crossFrameId);
        return identity.documentEpoch > crossStamp.identity.documentEpoch ? identity : undefined;
      } catch {
        return undefined;
      }
    }, "cross-document identity rotation");
    await waitFor(() => {
      try {
        return router.resolveFrameCommand({ pageScope, frameId: crossFrameId });
      } catch {
        return undefined;
      }
    }, "cross-document execution context");
    assert.equal(router.isCurrentDocument(crossStamp.identity), false);
    assert.throws(() => refs.resolve(oldReference.ref, pageScope), { code: "REFERENCE_DOCUMENT_NOT_CURRENT" });
    const crossAfterNavigation = await router.captureFrameIdentity({ pageScope, frameId: crossFrameId });
    await consumeEffects();
    assert.equal(crossAfterNavigation.identity.documentEpoch, crossStamp.identity.documentEpoch + 1);
    recordAssertion("cross-document navigation invalidates old router and ref identity", {
      before: crossStamp.identity,
      after: crossAfterNavigation.identity,
      oldReference: oldReference.ref,
    });

    const oldCrossIdentity = crossAfterNavigation.identity;
    const oldNestedIdentity = nestedStamp.identity;
    await evaluate(`document.querySelector('#cross').remove();true`);
    await waitFor(() => !router.isCurrentDocument(oldCrossIdentity), "removed cross frame invalidation");
    assert.equal(router.isCurrentDocument(oldNestedIdentity), false);
    await evaluate(`(() => {const frame=document.createElement('iframe');frame.id='cross-reinserted';frame.src=${JSON.stringify(crossUrl)};document.querySelector('#frames').append(frame);return true})()`);
    const reinsertedCrossFrameId = await waitFor(() => {
      const entries = [...observations.framesByUrl.entries()].filter(([url]) => /\/cross$/.test(new URL(url).pathname));
      return entries.map((entry) => entry[1]).find((frameId) => frameId !== crossFrameId);
    }, "reinserted cross frame");
    const reinsertedSessionId = await waitFor(() => observations.frameSessions.get(reinsertedCrossFrameId), "reinserted cross session");
    assert.notEqual(reinsertedCrossFrameId, crossFrameId);
    assert.notEqual(reinsertedSessionId, crossSessionId);
    await waitFor(() => {
      try {
        return router.resolveFrameCommand({ pageScope, frameId: reinsertedCrossFrameId });
      } catch {
        return undefined;
      }
    }, "reinserted cross context");
    const reinsertedStamp = await router.captureFrameIdentity({ pageScope, frameId: reinsertedCrossFrameId });
    await consumeEffects();
    recordAssertion("remove and reinsert rotates frame target session and identity", {
      oldFrameId: crossFrameId,
      oldSessionId: crossSessionId,
      newFrameId: reinsertedCrossFrameId,
      newSessionId: reinsertedSessionId,
      newIdentity: reinsertedStamp.identity,
    });

    const before = {
      root: rootStamp.identity,
      same: sameStamp.identity,
      cross: crossStamp.identity,
      nested: nestedStamp.identity,
    };
    const after = {
      crossAfterNavigation: crossAfterNavigation.identity,
      crossAfterReinsert: reinsertedStamp.identity,
      oldCrossCurrent: router.isCurrentDocument(oldCrossIdentity),
      oldNestedCurrent: router.isCurrentDocument(oldNestedIdentity),
      oldReferenceCurrent: (() => {
        try {
          refs.resolve(oldReference.ref, pageScope);
          return true;
        } catch {
          return false;
        }
      })(),
    };
    const evidence = {
      status: "passed",
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      defaultSiteIsolation: true,
      pageScope,
      rootTargetId,
      before,
      after,
      assertions,
      routedDialogs,
      dialogHandles,
      observations: {
        sessions: [...observations.sessions.values()],
        framesByUrl: [...observations.framesByUrl.entries()],
        frameSessions: [...observations.frameSessions.entries()],
        detachedFrames: observations.detachedFrames,
      },
      effects,
      rawEvents,
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "desktop-frame-router-smoke.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.error(`[frame-router-smoke] passed assertions=${assertions.length}`);
    completed = true;
  } finally {
    if (completed) {
      await eventChain.catch(() => {});
      debuggerApi.removeListener("message", onMessage);
      if (debuggerApi.isAttached()) debuggerApi.detach();
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

if (!process.versions.electron) {
  void runParent().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
