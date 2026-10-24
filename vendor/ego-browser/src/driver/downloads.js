import { mkdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cdp } from "../cdp-eval.js";
import { ensureSession, pageIdForSessionAlias, waitForBrowserEvent } from "../browser-runtime.js";
import { browserRefMap } from "../ref-state.js";
import { state } from "../state.js";
async function waitForEvent(eventName, options = {}) {
  if (eventName !== "download") {
    throw new Error(
      `page.waitForEvent currently supports only "download", got ${JSON.stringify(eventName)}`
    );
  }
  return waitForDownload(options);
}
async function waitForDownload(options = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const downloadDir = join(
    tmpdir(),
    `ego-browser-downloads-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(downloadDir, { recursive: true });
  const scoped = browserRefMap.isScopedMode();
  const rootSessionId = scoped ? await ensureSession() : void 0;
  const pageId = scoped ? pageIdForSessionAlias(rootSessionId) : void 0;
  if (scoped && !pageId) throw downloadSourceUnavailable();
  const sessionPromise = scoped ? Promise.resolve(rootSessionId) : ensureSession();
  const behaviorPromise = setDownloadBehavior(downloadDir, rootSessionId);
  let willBegin;
  let downloadGuid;
  const progressPromise = waitForBrowserEvent((event) => {
    if (scoped && pageIdForSessionAlias(rootSessionId) !== pageId) throw downloadSourceUnavailable();
    if (scoped && pageIdForSessionAlias(event?.sessionId) !== pageId) return false;
    if (!downloadGuid && event?.method === "Page.downloadWillBegin" && typeof event?.params?.guid === "string" && event.params.guid) {
      willBegin = event;
      downloadGuid = event?.params?.guid;
      return false;
    }
    return event?.method === "Page.downloadProgress" && event?.params?.guid === downloadGuid && (event?.params?.state === "completed" || event?.params?.state === "canceled");
  }, timeout);
  const [, , progress] = await Promise.all([sessionPromise, behaviorPromise, progressPromise]);
  if (!willBegin || !downloadGuid) throw new Error("Download did not emit Page.downloadWillBegin");
  const guid = downloadGuid;
  const suggestedFilename = willBegin.params?.suggestedFilename || guid || "download";
  if (progress.params?.state === "canceled") {
    throw new Error(`Download canceled: ${suggestedFilename}`);
  }
  const downloadedPath = join(downloadDir, suggestedFilename);
  const assertSource = () => {
    if (scoped && pageIdForSessionAlias(rootSessionId) !== pageId) throw downloadSourceUnavailable();
  };
  return {
    suggestedFilename: () => suggestedFilename,
    url: () => willBegin.params?.url || "",
    path: async () => { assertSource(); return downloadedPath; },
    saveAs: async (targetPath) => {
      assertSource();
      await copyFile(downloadedPath, targetPath);
      assertSource();
      try {
        await cdp("Ego.setDownloadPath", { guid, path: targetPath, sourcePath: downloadedPath }, rootSessionId);
      } catch (error) {
        if (scoped || !/Ego\.setDownloadPath.*(?:wasn't found|not found|unknown)|(?:wasn't found|not found|unknown).*Ego\.setDownloadPath/i.test(
          error?.message || ""
        )) {
          throw error;
        }
      }
      return targetPath;
    }
  };
}
async function setDownloadBehavior(downloadDir, rootSessionId) {
  try {
    await cdp("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true
    }, rootSessionId);
  } catch (error) {
    if (!/Browser\.setDownloadBehavior.*wasn't found|wasn't found/i.test(
      error?.message || ""
    )) {
      throw error;
    }
    await cdp("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir
    }, rootSessionId);
  }
}
function downloadSourceUnavailable() {
  return Object.assign(new Error("Download source page session is unavailable"), { error_code: "EGO_FRAME_UNAVAILABLE" });
}
export {
  waitForEvent
};
