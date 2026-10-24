import assert from "node:assert/strict";
import { webContents } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { translationScript, pageTranslation } from "./page-translation.mjs";
import { TRANSLATION_WORLD } from "./translation-service.mjs";

export async function runTranslationSmoke({ window, service, getTabs, getVisibleId, output, fixtureUrl, exit }) {
  const checks = {};
  const evaluate = code => window.webContents.executeJavaScript(code);
  const invoke = (method, payload) => evaluate(`window.egoDesktop.invoke(${JSON.stringify(method)},${JSON.stringify(payload)})`);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label) => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await sleep(70);
    }
    throw new Error(label);
  };
  const requests = [];
  const originalFetcher = service.fetcher;
  service.fetcher = async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return { ok: true, json: async () => body.map(row => ({
      translations: [{ to: "zh-Hans", text: row.Text.replace(/Hello/g, "你好").replace(/World/g, "世界").replace(/Dynamic/g, "动态") }],
    })) };
  };
  let failure;
  try {
    await until(() => evaluate('document.querySelector("#connection")?.textContent === "本地运行中"'), "Shell not ready");
    const task = await invoke("task.create", { name: "Translation verification" });
    await invoke("tab.open", { taskId: task.taskId, url: fixtureUrl, visual: true });
    const tab = await until(() => getTabs().find(t => t.webContentsId === getVisibleId() && t.url === fixtureUrl), "Fixture not visible");
    const target = webContents.fromId(tab.webContentsId);
    await until(() => target.executeJavaScript('!!document.querySelector("#hello")'), "Fixture not ready");
    const payload = { targetId: tab.targetId };
    const savedOriginal = await target.executeJavaScript('document.querySelector("#hello").innerHTML');
    window.show();
    window.focus();
    await until(() => evaluate('document.querySelector("#translation-panel")?.matches(":popover-open")'), "Foreign-language offer did not open automatically");
    checks.automaticForeignLanguageOffer = true;
    await evaluate('document.querySelector("#translation-panel [data-close]").click()');
    await sleep(1100);
    assert.equal(await evaluate('document.querySelector("#translation-panel").matches(":popover-open")'), false);
    const point = await evaluate(`(() => {
      const button = document.querySelector("#browser-translate");
      const r = button.getBoundingClientRect();
      const address = button.closest("form").getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x: Math.round(x), y: Math.round(y), inside: r.top >= address.top && r.bottom <= address.bottom,
        hittable: button.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert.equal(point.inside, true, "Translation button escaped address bar");
    assert.equal(point.hittable, true, "Translation button is covered");
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    checks.visibleToolbarPointerClick = true;
    await until(() => evaluate('document.querySelector("#translation-panel")?.matches(":popover-open") && !document.querySelector("[data-translate]").disabled'), "Translation panel not ready");
    assert.equal(await evaluate('document.querySelector("#translation-heading").textContent'), "翻译英语页面？");
    assert.equal(await evaluate('document.querySelector("[data-config]").hidden'), true);
    await evaluate('document.querySelector("[data-more]").click(); document.querySelector("[data-settings]").click()');
    await evaluate(`(() => {
      document.querySelector("#translation-panel [data-key]").value = "fixture-key";
      document.querySelector("[data-region]").value = "eastasia";
      document.querySelector("#translation-panel [data-consent]").checked = true;
      document.querySelector("[data-config]").requestSubmit();
    })()`);
    await until(() => evaluate('document.querySelector("#translation-panel [data-key]").placeholder.includes("已配置")'), "Settings did not save");
    assert.equal((await invoke("translation.settings", payload)).configured, true);
    await evaluate(`(() => {
      document.querySelector("[data-translate]").click();
    })()`);
    await until(() => target.executeJavaScript('document.querySelector("#hello").textContent.includes("你好")'), "Translation not applied");
    assert.equal(await evaluate('document.querySelector("#translation-panel").matches(":popover-open")'), false);
    await until(() => evaluate('document.querySelector("#browser-translate").dataset.translationState === "translated"'), "Closed-panel toolbar status not updated");
    checks.unobstructedReadingAndToolbarStatus = true;
    await evaluate('document.querySelector("#browser-translate").click()');
    await until(() => evaluate('!document.querySelector("#translation-panel [data-translate]").disabled'), "Translated panel not ready");
    checks.toolbarAndSettingsAndTranslation = true;
    assert.equal(await target.executeJavaScript('document.querySelector("#link") === window.originalLink'), true);
    assert.equal(await target.executeJavaScript('globalThis.__egoPageTranslation'), undefined);
    assert.equal(requests.flat().some(r => /PRIVATE|DO_NOT_TRANSLATE|const secret/.test(r.Text)), false);
    assert.equal(await target.executeJavaScript('document.querySelector("input").value'), "PRIVATE INPUT");
    checks.nodeIdentityAndPrivateFieldProtection = true;
    checks.isolatedWorld = true;
    await target.executeJavaScript(`document.body.insertAdjacentHTML("beforeend", '<p id="dynamic">Dynamic Hello</p>')`);
    await until(() => target.executeJavaScript('document.querySelector("#dynamic").textContent === "动态 你好"'), "Dynamic text not translated");
    checks.dynamicContent = true;
    await invoke("translation.cancel", payload);
    const beforeResume = await target.executeJavaScript('document.querySelector("#hello").innerHTML');
    await target.executeJavaScript(`document.body.insertAdjacentHTML("beforeend", '<p id="resumed">Dynamic Hello</p>')`);
    const requestsBeforeResume = requests.length;
    await invoke("translation.resume", { ...payload, consent: true });
    await until(() => target.executeJavaScript('document.querySelector("#resumed").textContent === "动态 你好"'), "Resume did not translate new content");
    assert.equal(await target.executeJavaScript('document.querySelector("#hello").innerHTML'), beforeResume);
    assert.equal(requests.slice(requestsBeforeResume).flat().some(r => r.Text.includes("World")), false);
    checks.resumePreservesTranslatedContent = true;
    await target.executeJavaScript('document.querySelector("#changed").textContent = "Website update"');
    await sleep(150);
    await invoke("translation.restore", payload);
    assert.equal(await target.executeJavaScript('document.querySelector("#hello").innerHTML'), savedOriginal);
    assert.equal(await target.executeJavaScript('document.querySelector("#changed").textContent'), "Website update");
    assert.equal(await target.executeJavaScript('document.querySelector("#dynamic").textContent'), "Dynamic Hello");
    checks.nonDestructiveRestore = true;
    await invoke("translation.start", { ...payload, consent: true });
    await until(() => target.executeJavaScript('document.querySelector("#hello").textContent.includes("你好")'), "Retry not applied");
    await until(() => evaluate('document.querySelector("#translation-heading").textContent === "此页已翻译"'), "Status not updated");
    for (const [name, width, height] of [["desktop", 1280, 880], ["compact", 940, 720]]) {
      window.setSize(width, height);
      await sleep(300);
      const layout = await evaluate(`(() => {
        const d = document.querySelector("#translation-panel");
        const r = d.getBoundingClientRect();
        const a = document.querySelector("#browser-translate").getBoundingClientRect();
        return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, overflow: d.scrollWidth > d.clientWidth,
          anchored: Math.abs(r.top - a.bottom - 8) < 2, nonModal: !document.querySelector(":modal") };
      })()`);
      assert.equal(layout.inside, true);
      assert.equal(layout.overflow, false);
      assert.equal(layout.anchored, true);
      assert.equal(layout.nonModal, true);
      writeFileSync(join(dirname(output), `translation-${name}.png`), (await window.webContents.capturePage()).toPNG());
    }
    checks.responsiveAnchoredPopover = true;
    await invoke("translation.restore", payload);
    await until(() => evaluate('document.querySelector("#translation-heading").textContent === "翻译英语页面？"'), "Original heading not restored");
    window.setSize(1280, 880);
    await sleep(200);
    writeFileSync(join(dirname(output), "translation-edge-style.png"), (await window.webContents.capturePage()).toPNG());
    const region = await evaluate(`(() => {
      const r = document.querySelector("#translation-panel").getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.x - 8)), y: Math.max(0, Math.floor(r.y - 48)), width: Math.ceil(r.width + 16), height: Math.ceil(r.height + 60) };
    })()`);
    writeFileSync(join(dirname(output), "translation-popover.png"), (await window.webContents.capturePage(region)).toPNG());
    await evaluate('document.querySelector("[data-close]").click()');
    await invoke("translation.restore", payload);

    // Verify malicious provider markup stays inert and marker errors are atomic.
    const token = "dom-security-fixture";
    const dom = async (command, data = {}) => {
      const result = await target.executeJavaScriptInIsolatedWorld(TRANSLATION_WORLD, [{ code: translationScript(command, { token, ...data }) }]);
      if (result.translationError) throw new Error(result.translationError);
      return result;
    };
    await dom("init");
    const batch = await dom("collect");
    await assert.rejects(dom("apply", { blocks: batch.blocks.map(b => ({ ...b, html: "<div>missing markers</div>" })) }), /标记/);
    assert.equal(await target.executeJavaScript('document.querySelector("#hello").innerHTML'), savedOriginal);
    await dom("apply", { blocks: batch.blocks.map(b => ({ ...b, html: b.html.replace("Hello", 'Hello<img src="/forbidden" onerror="window.INJECTED=1">') })) });
    assert.equal(await target.executeJavaScript('Boolean(window.INJECTED) || !!document.querySelector("img")'), false);
    await dom("restore");
    checks.inertMarkupAndAtomicValidation = true;

    let finish;
    service.fetcher = (_url, request) => new Promise(resolve => {
      finish = () => resolve({ ok: true, json: async () => JSON.parse(request.body).map(row => ({ translations: [{ to: "zh-Hans", text: row.Text.replace("Hello", "WRONG") }] })) });
    });
    await invoke("translation.start", { ...payload, consent: true });
    await until(() => finish, "No delayed request");
    await target.loadURL(`${fixtureUrl}next`);
    finish();
    await sleep(200);
    assert.equal(await target.executeJavaScript('document.querySelector("#hello").textContent'), "Hello World");
    assert.equal(service.status(tab.targetId).phase, "original");
    checks.navigationDropsLateResponse = true;
    await target.loadURL(`${fixtureUrl}chinese`);
    await target.executeJavaScript('document.documentElement.lang = "zh-CN"');
    await sleep(1400);
    assert.equal(await evaluate('document.querySelector("#translation-panel").matches(":popover-open")'), false);
    checks.noOfferForTargetLanguage = true;
    checks.provider = "fixture responses only; Azure network not tested";
    assert.equal(typeof pageTranslation, "function");
  } catch (error) {
    failure = error;
    writeFileSync(join(dirname(output), "translation-failure.png"), (await window.webContents.capturePage()).toPNG());
  } finally {
    for (const job of service.jobs.values()) service.cancel(job.id, true);
    service.fetcher = originalFetcher;
  }
  writeFileSync(output, JSON.stringify({ passed: !failure, checks, ...(failure ? { error: failure.stack } : {}) }, null, 2), "utf8");
  exit(failure ? 1 : 0);
}
