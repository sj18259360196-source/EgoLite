import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";

// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { clearPageSessionAliases, registerPageSessionAlias } from "../../../vendor/ego-browser/src/browser-runtime.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap } from "../../../vendor/ego-browser/src/ref-state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { setOverrides, state } from "../../../vendor/ego-browser/src/state.js";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { waitForEvent } from "../../../vendor/ego-browser/src/driver/downloads.js";

test("scoped download settings, events and saveAs retain the original page after an SDK page switch", async (t) => {
  const fixture = await downloadFixture(t);
  const pending = waitForEvent("download", { timeout: 1_000 });
  await nextTurn();
  await fixture.fileReady;
  assert.equal(fixture.calls.find((call) => call.method === "Browser.setDownloadBehavior")?.sessionId, "download-root-A");
  Object.assign(state, { sessionId: "download-root-B", sessionTargetId: "download-page-B", sessionAt: Date.now() });
  fixture.emit("Page.downloadWillBegin", "download-root-B", { guid: "foreign", suggestedFilename: "wrong.txt" });
  fixture.emit("Page.downloadWillBegin", undefined, { guid: "unknown", suggestedFilename: "unknown.txt" });
  fixture.emit("Page.downloadWillBegin", "download-child-A", { guid: "original", suggestedFilename: "fixture.txt", url: "https://fixture.test/original" });
  fixture.emit("Page.downloadProgress", "download-root-B", { guid: "original", state: "canceled" });
  fixture.emit("Page.downloadProgress", "download-root-A", { guid: "other", state: "canceled" });
  fixture.emit("Page.downloadProgress", "download-root-A", { guid: "original", state: "completed" });
  const download = await pending;
  assert.equal(download.suggestedFilename(), "fixture.txt");
  assert.equal(download.url(), "https://fixture.test/original");
  const sourcePath = await download.path();
  assert.equal(await readFile(sourcePath, "utf8"), "original-page-download");
  const destination = join(fixture.run, "saved.txt");
  assert.equal(await download.saveAs(destination), destination);
  assert.equal(await readFile(destination, "utf8"), "original-page-download");
  const save = fixture.calls.find((call) => call.method === "Ego.setDownloadPath");
  assert.equal(save?.sessionId, "download-root-A");
  assert.deepEqual(save?.params, { guid: "original", path: destination, sourcePath });

  fixture.emit("Target.detachedFromTarget", "download-root-A", { sessionId: "download-root-A" });
  const callsBefore = fixture.calls.length;
  await assert.rejects(download.path(), isSourceUnavailable);
  await assert.rejects(download.saveAs(join(fixture.run, "retired.txt")), isSourceUnavailable);
  assert.equal(fixture.calls.length, callsBefore);
  await assert.rejects(access(join(fixture.run, "retired.txt")));
});

test("retiring the original download session fails the wait instead of accepting another page", async (t) => {
  const fixture = await downloadFixture(t);
  const pending = waitForEvent("download", { timeout: 1_000 });
  const rejected = assert.rejects(pending, isSourceUnavailable);
  await nextTurn();
  await fixture.fileReady;
  fixture.emit("Page.downloadWillBegin", "download-root-A", { guid: "original", suggestedFilename: "fixture.txt" });
  fixture.emit("Target.detachedFromTarget", "download-root-A", { sessionId: "download-root-A" });
  await rejected;
});

test("native download behavior retains browser-level routing and its legacy local save fallback", async (t) => {
  const fixture = await downloadFixture(t, false);
  fixture.unsupportedSave = true;
  const pending = waitForEvent("download", { timeout: 1_000 });
  await nextTurn();
  await fixture.fileReady;
  assert.equal(fixture.calls.find((call) => call.method === "Browser.setDownloadBehavior")?.sessionId, undefined);
  fixture.emit("Page.downloadWillBegin", undefined, { guid: "native", suggestedFilename: "fixture.txt" });
  fixture.emit("Page.downloadProgress", undefined, { guid: "native", state: "completed" });
  const download = await pending;
  const destination = join(fixture.run, "legacy-saved.txt");
  assert.equal(await download.saveAs(destination), destination);
  assert.equal(await readFile(destination, "utf8"), "original-page-download");
});

async function downloadFixture(t: TestContext, scoped = true) {
  const base = resolve(import.meta.dirname, "../../../.tmp/codex/p1-implementation-20260916/client-resume");
  const baseExisted = await access(base).then(() => true, () => false);
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(join(base, "downloads-"));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  process.env.TEMP = run;
  process.env.TMP = run;
  assert.equal(resolve(tmpdir()), resolve(run));
  const previousEgo = (globalThis as any).ego;
  const restoreState = setOverrides({ sessionId: "download-root-A", sessionTargetId: "download-page-A", sessionAt: Date.now(), sessionInflight: null });
  const fixture = {
    run,
    calls: [] as any[],
    fileReady: Promise.resolve(),
    unsupportedSave: false,
    emit(method: string, sessionId: string | undefined, params: any) {
      runtime.onCDPMessage(JSON.stringify({ method, sessionId, params }));
    },
  };
  const runtime: any = {
    sendCDPMessage(payload: string) {
      const request = JSON.parse(payload);
      fixture.calls.push(request);
      if (request.method === "Browser.setDownloadBehavior" || request.method === "Page.setDownloadBehavior") {
        assert.ok(resolve(request.params.downloadPath).startsWith(resolve(run) + sep));
        fixture.fileReady = writeFile(join(request.params.downloadPath, "fixture.txt"), "original-page-download", "utf8");
      }
      void fixture.fileReady.then(() => runtime.onCDPMessage(JSON.stringify({
        id: request.id,
        ...(request.method === "Ego.setDownloadPath" && fixture.unsupportedSave
          ? { error: { message: "Ego.setDownloadPath wasn't found" } }
          : { result: {} }),
      })));
    },
  };
  (globalThis as any).ego = runtime;
  registerPageSessionAlias("download-root-A", "download-page-A");
  registerPageSessionAlias("download-child-A", "download-page-A");
  registerPageSessionAlias("download-root-B", "download-page-B");
  browserRefMap.beginSnapshot(scoped ? "scoped-v1" : "native-v0", { runtimeId: "download-runtime", pageId: "download-page-A" });
  t.after(async () => {
    clearPageSessionAliases("download-page-A");
    clearPageSessionAliases("download-page-B");
    browserRefMap.beginSnapshot("native-v0");
    restoreState();
    if (previousEgo === undefined) delete (globalThis as any).ego;
    else (globalThis as any).ego = previousEgo;
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
    assert.ok(resolve(run).startsWith(base + sep));
    await rm(run, { recursive: true, force: true });
    if (!baseExisted) await rmdir(base);
  });
  return fixture;
}
function nextTurn(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
function isSourceUnavailable(error: unknown): boolean { return (error as { error_code?: string })?.error_code === "EGO_FRAME_UNAVAILABLE"; }
