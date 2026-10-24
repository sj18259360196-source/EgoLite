import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CosFrames, validateScriptTarget } from "./cos-frames.mjs";

function fixture() {
  const debuggerApi = new EventEmitter();
  const calls = [];
  let loader = "first";
  let removed = false;
  const command = async (name, params, session) => {
    calls.push({ name, params, session });
    if (name === "Page.getFrameTree") return { frameTree: session
      ? { frame: { id: "remote", loaderId: loader } }
      : { frame: { id: "top", loaderId: "top-document" } } };
    if (name === "DOM.getDocument") return { root: { nodeName: "#document", children: !session && !removed
      ? [{ nodeName: "IFRAME", frameId: "remote" }] : [] } };
    if (name === "Target.attachToTarget") return { sessionId: "owned-session" };
    if (name === "Target.getTargets") return { targetInfos: [{ type: "iframe", targetId: "remote" }] };
    if (name === "Page.createIsolatedWorld") return { executionContextId: 12 };
    if (name === "Runtime.evaluate") return { result: { value: "ok" } };
    return {};
  };
  debuggerApi.sendCommand = command;
  const frames = new CosFrames({ debugger: debuggerApi }, command, () => {});
  return { frames, calls, debuggerApi, navigate: () => { loader = "second"; }, remove: () => { removed = true; } };
}

test("script target selection rejects conflicting, empty and malformed selectors", () => {
  for (const target of [{ allFrames: true, frameIds: [0] }, { frameIds: [0], documentIds: ["a"] },
    { frameIds: [] }, { frameIds: [-1] }, { documentIds: [""] }]) assert.throws(() => validateScriptTarget(target));
  for (const target of [{}, { allFrames: true }, { frameIds: [0, 1] }, { documentIds: ["a", "b"] }]) validateScriptTarget(target);
});

test("OOPIF discovery attaches only frame-owner targets and routes execution through owned session", async () => {
  const { frames, calls } = fixture();
  const list = await frames.refresh();
  assert.equal(list.length, 2);
  assert.equal(list[0].frameId, 0);
  assert.deepEqual(calls.filter(call => call.name === "Target.attachToTarget").map(call => call.params.targetId), ["remote"]);
  assert.equal((await frames.execute(list[1], "'ok'", "ISOLATED")).result, "ok");
  assert.equal(calls.find(call => call.name === "Runtime.evaluate").session, "owned-session");
  await frames.stop();
});

test("navigation invalidates old child documents; removed frames release only owned sessions", async () => {
  const { frames, navigate, remove, calls, debuggerApi } = fixture();
  const before = (await frames.refresh())[1];
  navigate();
  await assert.rejects(frames.execute(before, "sideEffect()", "ISOLATED"), /stale/);
  assert.equal(calls.some(call => call.name === "Runtime.evaluate"), false);
  const after = (await frames.refresh())[1];
  assert.equal(before.frameId, after.frameId);
  assert.notEqual(before.documentId, after.documentId);
  remove();
  assert.equal((await frames.refresh()).length, 1);
  assert.deepEqual(calls.filter(call => call.name === "Target.detachFromTarget").map(call => call.params.sessionId), ["owned-session"]);
  await frames.stop();
  assert.equal(debuggerApi.listenerCount("message"), 0);
});
