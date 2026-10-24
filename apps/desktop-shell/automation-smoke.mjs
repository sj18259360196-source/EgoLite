import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AtomicJsonStateWriter } from "./atomic-json-state-writer.mjs";
import { dirname, join } from "node:path";

export async function runAutomationSmoke({ window, service, output, ready, finish, exit }) {
  window.on("close", () => console.log("automation-smoke-window-close"));
  window.webContents.on("render-process-gone", (_event, details) => console.log("automation-smoke-renderer-gone", JSON.stringify(details)));
  const live = process.env.EGO_AUTOMATION_SMOKE_LIVE === "1";
  const liveKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const evaluate = code => window.webContents.executeJavaScript(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(100);
    }
    throw new Error(label);
  };
  const requests = [];
  const checks = {};
  const original = service.fetcher;
  service.fetcher = async (url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    if (live) return original(url, request);
    if (body.state.goal?.includes("delayed")) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 12000);
        request.signal.addEventListener("abort", () => { clearTimeout(timer); reject(request.signal.reason); }, { once: true });
        if (body.state.goal.includes("UI stop")) {
          void (async () => {
            await evaluate('document.querySelector("#titlebar-settings").click(); document.querySelector("[data-open-view=agent-settings]").click()');
            await until(() => evaluate('!!document.querySelector("#automation-settings [data-jobs] button")'), "Stop button not available");
            await evaluate('document.querySelector("#automation-settings [data-jobs] button").click()');
            checks.nativeStopButton = true;
          })().catch(error => { clearTimeout(timer); reject(error); });
        }
      });
    }
    const answers = {};
    const query = body.state.elements?.find(element => ["Query", "查询"].includes(element.label));
    const fill = /^(Fill supplied|填入提供的)/.test(body.state.goal || "") && !query?.state?.matchingValueKeys?.includes("query");
    for (const [id, question] of Object.entries(body.questions)) {
      let choice = "none";
      if (id === "action") choice = "search";
      if (id === "operation") choice = fill ? "fill" : "click";
      if (id === "click_target") choice = body.state.elements?.find(element => ["Continue", "继续"].includes(element.label))?.id || "none";
      if (id === `value_for_${query?.id}` && fill) choice = "query";
      answers[id] = { type: "choice", choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 123, output_tokens: 0 } }));
  };
  let failure;
  try {
    await until(() => evaluate('document.querySelector("#connection")?.textContent === "本地运行中"'), "Shell did not connect");
    await evaluate('document.querySelector("#titlebar-settings").click()');
    await evaluate('document.querySelector("[data-open-view=agent-settings]").click()');
    await until(() => evaluate('document.querySelector("#automation-settings [data-key]")?.placeholder === "尚未配置"'), "Automation settings not ready");
    if (live) {
      service.settings.save("default", { key: liveKey, memoryOnly: true, cloudConsent: true });
      await evaluate('document.querySelector("#automation-settings [data-refresh]").click()');
    } else {
    await evaluate(`(() => {
      const root = document.querySelector("#automation-settings");
      root.querySelector("[data-key]").value = "fixture-key-automation";
      root.querySelector("[data-consent]").checked = true;
      root.querySelector("form").requestSubmit();
    })()`);
    }
    await until(() => evaluate('document.querySelector("#automation-settings [data-key]").placeholder.includes("已保存")'), "Key not saved");
    assert.equal(await evaluate('document.querySelector("#automation-settings [data-key]").value'), "");
    checks.secureSettingsUI = true;
    await evaluate('document.querySelector("#automation-settings [data-test]").click()');
    await until(() => evaluate('document.querySelector("#automation-settings [data-status]").textContent.includes("测试通过")'), "Connection UI test failed");
    checks[live ? "connectionTestUIWithLiveProvider" : "connectionTestUIWithMockProvider"] = true;
    window.show();
    window.unmaximize();
    await sleep(150);
    for (const [name, width, height] of [["desktop", 1280, 880], ["compact", 940, 720]]) {
      window.setSize(width, height);
      await until(() => Math.abs(window.getSize()[0] - width) <= 2 && Math.abs(window.getSize()[1] - height) <= 2,
        `Window did not resize (${window.getSize().join("x")}, maximized=${window.isMaximized()})`);
      let layout;
      await until(async () => {
        await evaluate('document.querySelector("#automation-settings").scrollIntoView({block:"start",behavior:"instant"})');
        layout = await evaluate(`(() => {
        const root = document.querySelector("#automation-settings");
        const r = root.getBoundingClientRect();
        return { inside: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth
          && r.top >= 0 && r.top < innerHeight, overflow: root.scrollWidth > root.clientWidth };
      })()`);
        return layout.inside && !layout.overflow;
      }, "Automation settings layout did not settle", 5000);
      assert.equal(layout.inside, true);
      assert.equal(layout.overflow, false);
      writeFileSync(join(dirname(output), `settings-${name}.png`), (await window.webContents.capturePage()).toPNG());
    }
    checks.responsiveSettings = true;
    if (process.env.EGO_AUTOMATION_SMOKE_BLURRED === "1") window.blur();
    writeFileSync(ready, JSON.stringify({ ready: true }), "utf8");
    let controlledId;
    await until(async () => {
      const control = process.env.EGO_AUTOMATION_SMOKE_CONTROL;
      if (control && existsSync(control)) {
        const command = JSON.parse(readFileSync(control, "utf8"));
        if (command.id !== controlledId && ["focus", "blur", "hide"].includes(command.action)) {
          if (command.action === "focus") window.show();
          window[command.action]();
          await sleep(150);
          controlledId = command.id;
          const acknowledged = process.env.EGO_AUTOMATION_SMOKE_CONTROLLED;
          await new Promise((resolve, reject) => new AtomicJsonStateWriter(acknowledged,
            { onCommit: resolve, onFailure: reject }).write({ id: controlledId, focused: window.isFocused(), visible: window.isVisible() }));
        }
      }
      return existsSync(finish);
    }, "MCP harness did not finish", process.env.EGO_AUTOMATION_SMOKE_CORPUS === "1" ? 1800000 : 180000);
    checks.noPrivateValuesSent = !JSON.stringify(requests).includes("PRIVATE_FORM_VALUE");
    assert.equal(checks.noPrivateValuesSent, true);
    checks.providerRequests = requests.length;
    checks.provider = live ? "TypeSafe live API" : "mock only; real TypeSafe service not tested";
  } catch (error) {
    failure = error;
    writeFileSync(join(dirname(output), "settings-failure.png"), (await window.webContents.capturePage()).toPNG());
  } finally {
    for (const job of service.jobs.values()) service.cancel(job.id);
    service.fetcher = original;
    writeFileSync(output, JSON.stringify({ passed: !failure, checks, ...(failure ? { error: failure.stack } : {}) }, null, 2), "utf8");
    console.log("automation-smoke-finish", failure ? "failed" : "passed");
    exit(failure ? 1 : 0);
  }
}
