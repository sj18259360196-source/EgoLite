import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { CosCompanion } from "./cos-companion.mjs";

async function setup(t) {
  const root = resolve(import.meta.dirname, "../../../.tmp/codex/cos-integration");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "companion-unit-"));
  await mkdir(join(directory, "source/extension"), { recursive: true });
  await writeFile(join(directory, "source/extension/manifest.json"), JSON.stringify({ version: "fixture" }));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ entries: { companion: "fixture.mjs" } }));
  await writeFile(join(directory, "fixture.mjs"), `
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if(message.type === "reload") { reply({ok:true}); setTimeout(()=>chrome.runtime.reload(),10);return true; }
      void (async()=>{
        const state = await chrome.storage.session.get("count");
        const count = (state.count || 0) + 1;
        await chrome.storage.session.set({count});
        reply({count});
      })();
      return true;
    });
    export async function egoWake() {}
  `);
  const companion = new CosCompanion({ directory, dataDirectory: join(directory, "state"), call: async () => null });
  t.after(async () => {
    await companion.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return companion;
}

test("companion reload keeps session storage and accepts page messages", async t => {
  const companion = await setup(t);
  await companion.start();
  assert.equal((await companion.message({ type: "count" })).count, 1);
  const restarted = once(companion, "restarted");
  assert.equal((await companion.message({ type: "reload" })).ok, true);
  await restarted;
  assert.equal((await companion.message({ type: "count" })).count, 2);
});

test("stop during companion restart fences replacement worker", async t => {
  const companion = await setup(t);
  await companion.start();
  const restart = companion.restart();
  assert.equal(companion.restart(), restart);
  await companion.stop();
  assert.equal(await restart, false);
  await assert.rejects(companion.message({ type: "count" }), /not running/);
});

test("stop cancels a companion start awaiting package reads", async t => {
  const companion = await setup(t);
  const start = companion.start();
  const rejected = assert.rejects(start, /cancelled/);
  await companion.stop();
  await rejected;
  await assert.rejects(companion.message({ type: "count" }), /not running/);
});
