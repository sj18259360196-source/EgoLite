import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { clearPageSessionAliases, getPageSessionAliases, pageIdForSessionAlias, registerPageSessionAlias } from "../../../vendor/ego-browser/src/browser-runtime.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap } from "../../../vendor/ego-browser/src/ref-state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { setOverrides, state } from "../../../vendor/ego-browser/src/state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { waitForRequest, waitForResponse } from "../../../vendor/ego-browser/src/driver/waits.js";

test("scoped network waits enable only the fixed page sessions and retain per-session request/body identity", async (t) => {
  const fixture = networkFixture(t);
  const pending = waitForResponse((response: any) => response.url() === "https://fixture.test/result", { timeout: 1_000 });
  await nextTurn();
  assert.deepEqual(fixture.calls.find((call) => call.method === "Ego.getPageSessions")?.sessionId, "network-root-A");
  assert.deepEqual(fixture.calls.filter((call) => call.method === "Network.enable").map((call) => call.sessionId).sort(), [
    "network-child-A", "network-child-A2", "network-root-A",
  ]);

  fixture.emit("Network.responseReceived", "network-root-B", { requestId: "collision", response: { url: "https://fixture.test/result", status: 201 } });
  fixture.emit("Network.responseReceived", "unknown-source", { requestId: "collision", response: { url: "https://fixture.test/result", status: 202 } });
  registerPageSessionAlias("network-new-child-A", "network-page-A");
  fixture.emit("Network.responseReceived", "network-new-child-A", { requestId: "collision", response: { url: "https://fixture.test/result", status: 203 } });
  fixture.emit("Network.requestWillBeSent", "network-child-A", { requestId: "collision", request: { url: "https://fixture.test/result", method: "PUT" } });
  fixture.emit("Network.requestWillBeSent", "network-root-A", { requestId: "collision", request: { url: "https://fixture.test/other", method: "POST" } });
  fixture.emit("Network.responseReceived", "network-child-A", { requestId: "collision", response: { url: "https://fixture.test/result", status: 200 } });
  const response = await pending;
  assert.equal(response.status(), 200);
  assert.equal(response.request().method(), "PUT");
  Object.assign(state, { sessionId: "network-root-B", sessionTargetId: "network-page-B", sessionAt: Date.now() });
  assert.equal(await response.text(), "body:network-child-A");
  assert.deepEqual(fixture.calls.at(-1), {
    id: fixture.calls.at(-1).id,
    method: "Network.getResponseBody",
    params: { requestId: "collision" },
    sessionId: "network-child-A",
  });

  fixture.emit("Target.detachedFromTarget", "network-root-A", { sessionId: "network-child-A" });
  const callsBefore = fixture.calls.length;
  await assert.rejects(response.text(), (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE");
  assert.equal(fixture.calls.length, callsBefore);
});

test("scoped request wait excludes another page after a switch and accepts an existing nested child", async (t) => {
  const fixture = networkFixture(t);
  const pending = waitForRequest("https://fixture.test/request", { timeout: 1_000 });
  await nextTurn();
  Object.assign(state, { sessionId: "network-root-B", sessionTargetId: "network-page-B", sessionAt: Date.now() });
  fixture.emit("Network.requestWillBeSent", "network-root-B", { requestId: "1", request: { url: "https://fixture.test/request", method: "WRONG" } });
  fixture.emit("Network.requestWillBeSent", "network-child-A2", { requestId: "1", request: { url: "https://fixture.test/request", method: "GET" } });
  assert.equal((await pending).method(), "GET");
});

test("scoped network enumeration absence and malformed scope fail before any Network enable", async (t) => {
  const fixture = networkFixture(t);
  fixture.enumerationError = { message: "'Ego.getPageSessions' wasn't found" };
  await assert.rejects(waitForResponse("https://fixture.test/result", { timeout: 100 }), (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE");
  assert.equal(fixture.calls.some((call) => call.method === "Network.enable"), false);

  fixture.enumerationError = undefined;
  fixture.enumeration = { pageId: "network-page-B", sessions: [{ sessionId: "network-root-A" }] };
  await assert.rejects(getPageSessionAliases("network-root-A"), (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH");
  fixture.enumeration = { pageId: "network-page-A", sessions: [{ sessionId: "network-root-A" }, { sessionId: "network-root-B" }] };
  await assert.rejects(getPageSessionAliases("network-root-A"), (error: any) => error?.error_code === "EGO_ACTION_SCOPE_MISMATCH");
  assert.equal(pageIdForSessionAlias("network-root-B"), "network-page-B");
  fixture.enumeration = { pageId: "network-page-A", sessions: [{ sessionId: "network-child-A" }] };
  await assert.rejects(getPageSessionAliases("network-root-A"), (error: any) => error?.error_code === "EGO_INVALID_RESULT_PAYLOAD");
});

test("scoped Network enable and response body failures preserve typed source errors", async (t) => {
  const fixture = networkFixture(t);
  fixture.enableFailure = "network-child-A";
  await assert.rejects(waitForResponse("https://fixture.test/result", { timeout: 100 }), (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE");
  fixture.enableFailure = undefined;
  const pending = waitForResponse("https://fixture.test/result", { timeout: 1_000 });
  await nextTurn();
  fixture.emit("Network.responseReceived", "network-child-A", { requestId: "1", response: { url: "https://fixture.test/result", status: 200 } });
  const response = await pending;
  fixture.bodyFailure = { error_code: "EGO_FRAME_UNAVAILABLE", message: "Source retired" };
  await assert.rejects(response.text(), (error: any) => error?.error_code === "EGO_FRAME_UNAVAILABLE");
  assert.equal(fixture.calls.filter((call) => call.method === "Network.getResponseBody").length, 1);
});

test("native network waits retain the legacy contract without the scoped extension", async (t) => {
  const fixture = networkFixture(t, false);
  const pending = waitForResponse("https://fixture.test/result", { timeout: 1_000 });
  await nextTurn();
  assert.equal(fixture.calls.some((call) => call.method === "Ego.getPageSessions"), false);
  assert.deepEqual(fixture.calls.filter((call) => call.method === "Network.enable").map((call) => call.sessionId), ["network-root-A"]);
  fixture.emit("Network.responseReceived", undefined, { requestId: "legacy", response: { url: "https://fixture.test/result", status: 200 } });
  assert.equal(await (await pending).text(), "body:network-root-A");
});

function networkFixture(t: TestContext, scoped = true) {
  const previousEgo = (globalThis as any).ego;
  const restoreState = setOverrides({
    sessionId: "network-root-A", sessionTargetId: "network-page-A", sessionAt: Date.now(),
    sessionInflight: null, preferredTargetId: null,
  });
  const fixture: {
    calls: any[];
    enumeration: any;
    enumerationError?: any;
    enableFailure?: string | undefined;
    bodyFailure?: any;
    emit(method: string, sessionId: string | undefined, params: any): void;
  } = {
    calls: [],
    enumeration: { pageId: "network-page-A", sessions: [
      { sessionId: "network-root-A" }, { sessionId: "network-child-A" }, { sessionId: "network-child-A2", frameId: "nested-frame" },
    ] },
    emit(method, sessionId, params) { runtime.onCDPMessage(JSON.stringify({ method, sessionId, params })); },
  };
  const runtime: any = {
    sendCDPMessage(payload: string) {
      const request = JSON.parse(payload);
      fixture.calls.push(request);
      let result: any = {};
      let error: any;
      if (request.method === "Ego.getPageSessions") { result = fixture.enumeration; error = fixture.enumerationError; }
      else if (request.method === "Network.enable" && request.sessionId === fixture.enableFailure) {
        error = { error_code: "EGO_FRAME_UNAVAILABLE", message: "Network source unavailable" };
      } else if (request.method === "Network.getResponseBody") {
        result = { body: `body:${request.sessionId}`, base64Encoded: false };
        error = fixture.bodyFailure;
      }
      queueMicrotask(() => runtime.onCDPMessage(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) })));
    },
  };
  (globalThis as any).ego = runtime;
  registerPageSessionAlias("network-root-A", "network-page-A");
  registerPageSessionAlias("network-root-B", "network-page-B");
  browserRefMap.beginSnapshot(scoped ? "scoped-v1" : "native-v0", { runtimeId: "network-runtime", pageId: "network-page-A" });
  t.after(() => {
    clearPageSessionAliases("network-page-A");
    clearPageSessionAliases("network-page-B");
    browserRefMap.beginSnapshot("native-v0");
    restoreState();
    if (previousEgo === undefined) delete (globalThis as any).ego;
    else (globalThis as any).ego = previousEgo;
  });
  return fixture;
}

function nextTurn(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
