import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { pageBootstrap, disposeCosPageScripts } from "./cos-page-agent.mjs";

function setup(hostname = "chatgpt.com", child = false) {
  const sent = [];
  const context = vm.createContext({ setTimeout, clearTimeout, location: { hostname, protocol: "https:" }, binding: text => sent.push(JSON.parse(text)) });
  vm.runInContext(`window=globalThis;top=${child ? "{}" : "globalThis"};(${pageBootstrap.toString()})("binding")`, context);
  return { context, sent, evaluate: expression => vm.runInContext(expression, context) };
}

test("page bridge is restricted to supported top-level pages", () => {
  assert.equal(setup("example.com").evaluate("typeof chrome"), "undefined");
  assert.equal(setup("chatgpt.com", true).evaluate("typeof chrome"), "undefined");
});

test("page messages correlate replies and stop rejects pending work", async () => {
  const { sent, evaluate } = setup();
  const answer = evaluate("chrome.runtime.sendMessage({type:'status'})");
  assert.equal(sent[0].method, "message");
  evaluate(`__egoCosPage.reply(${sent[0].id},{ok:true})`);
  assert.equal((await answer).ok, true);
  const pending = evaluate("chrome.runtime.sendMessage({type:'status'})");
  const rejected = assert.rejects(pending, /stopped/);
  evaluate("__egoCosPage.stop()");
  await rejected;
  assert.equal(evaluate("chrome.runtime.id"), undefined);
  await assert.rejects(evaluate("chrome.runtime.sendMessage({})"), /stopped/);
});

test("background messages preserve callback and asynchronous response semantics", async () => {
  const { evaluate } = setup();
  evaluate("chrome.runtime.onMessage.addListener((message,sender,reply)=>{setTimeout(()=>reply({value:message.value+1}),0);return true;})");
  assert.equal((await evaluate("__egoCosPage.dispatch({value:4})")).value, 5);
  evaluate("__egoCosPage.stop()");
});

test("page preferences are requested through the host without exposing storage", async () => {
  const { sent, evaluate } = setup();
  const preferences = evaluate("chrome.storage.local.get(['renderStreamEnabled'])");
  assert.equal(sent[0].method, "preferences");
  assert.equal(evaluate("typeof chrome.storage.local.set"), "undefined");
  evaluate(`__egoCosPage.reply(${sent[0].id},{renderStreamEnabled:false})`);
  assert.equal((await preferences).renderStreamEnabled, false);
  evaluate("__egoCosPage.stop()");
});

test("page disposal continues after a vanished document and only removes owned registrations", async () => {
  const calls = [];
  const errors = await disposeCosPageScripts(async (method, params) => {
    calls.push({ method, params });
    if (params.contextId === 7) throw new Error("Cannot find context with specified id");
  }, [7, 8], ["owned-script"]);
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 5);
  assert.equal(calls[1].params.contextId, 8);
  assert.deepEqual(calls[3], { method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier: "owned-script" } });
  assert.equal(calls[4].method, "Runtime.removeBinding");
  assert.ok(calls.every(call => !call.method.startsWith("Input.") && !call.method.includes("navigate")));
});

test("a stopped page shim can be reinstalled without reloading the document", async () => {
  const { context, sent, evaluate } = setup();
  evaluate("__egoCosPage.stop()");
  vm.runInContext(`(${pageBootstrap.toString()})("binding")`, context);
  assert.equal(evaluate("chrome.runtime.id"), "ego-cos-hosted");
  const response = evaluate("chrome.runtime.sendMessage({type:'status'})");
  evaluate(`__egoCosPage.reply(${sent.at(-1).id},{ok:true})`);
  assert.equal((await response).ok, true);
  evaluate("__egoCosPage.stop()");
});
