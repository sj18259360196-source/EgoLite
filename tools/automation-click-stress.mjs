import { setTimeout as delay } from "node:timers/promises";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { parseCandidates } from "../apps/ego-mcp-server/src/automation/page-data.ts";

export async function probeScopedClicks(pipe, baseUrl, { setWindow, checkpoint }) {
  const session = await EgoMcpSession.connect(pipe, { autoStartDesktop: false });
  const samples = [];
  try {
    await session.sdk.taskSpaces.useOrCreate("Scoped click sequence probe");
    await session.sdk.browser.openOrReuseTab(baseUrl, { wait: true });
    for (const windowMode of ["focus", "blur", "hide"]) {
      for (let repeat = 0; repeat < 4; repeat++) {
        const sample = { windowMode, repeat, success: false };
        try {
          await session.sdk.page.goto(new URL(`/corpus/en-form-${repeat % 3 + 1}`, baseUrl).href, { waitUntil: "load" });
          await session.sdk.page.locator("#name").fill("Probe Reader");
          await session.sdk.page.locator("#city").fill("Probe City");
          await setWindow(windowMode);
          await session.sdk.page.snapshot();
          await delay(350);
          const snapshot = await session.sdk.page.snapshot();
          const candidate = parseCandidates(snapshot).find(item => item.role === "button" && item.label === "Continue");
          if (!candidate) throw new Error("Continue not observed");
          sample.before = await session.sdk.page.evaluate('({focused:document.hasFocus(),visibility:document.visibilityState,events:window.__automationEvents})');
          const started = performance.now();
          try { await session.sdk.page.locator(candidate.ref).click({ timeout: 4000, activation: "auto" }); }
          finally { sample.clickMs = performance.now() - started; }
          sample.success = await session.sdk.page.evaluate('!document.querySelector("#done").hidden');
        } catch (error) { sample.error = { message: error.message, code: error.error_code || error.code }; }
        try { sample.after = await session.sdk.page.evaluate('({focused:document.hasFocus(),visibility:document.visibilityState,events:window.__automationEvents,done:!document.querySelector("#done").hidden})'); } catch {}
        samples.push(sample);
        checkpoint(samples);
      }
    }
    return { passed: samples.every(item => item.success), samples };
  } finally { await session.close(); }
}
