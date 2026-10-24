import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { parseBookmarksDocument, libraryToBookmarksHtml } from "./collection-transfer.mjs";

export async function runBookmarkLibrarySmoke({ window, output, exit }) {
  window.webContents.setBackgroundThrottling(false);
  const fixture = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.setHeader("Content-Type", "image/x-icon");
      response.end(readFileSync(join(import.meta.dirname, "public/assets/ego-app.ico")));
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><title>Bookmark fixture</title><link rel="icon" href="/favicon.ico"><h1>Bookmark fixture</h1>');
  });
  const checks = new Proxy({}, { set(target, key, value) {
    target[key] = value;
    console.log(`[bookmark-smoke] ${String(key)}: ${value}`);
    return true;
  } });
  const errors = [];
  window.webContents.on("console-message", event => {
    if (event.level === "error" || event.level === 3) errors.push(event.message);
  });
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const wait = async (code, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(code)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const activeSelector = selector => selector.replace(/\.bm-dialog(?=\s)/g, ".bm-dialog[open]");
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(activeSelector(selector))}).click()`);
  const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(activeSelector(selector))}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const snapshot = () => evaluate(`window.egoDesktop.invoke("collection.library")`);
  const submit = async () => {
    await evaluate(`document.querySelector(".bm-dialog[open] form").requestSubmit()`);
    await wait(`!document.querySelector(".bm-dialog[open]")`, "dialog saved");
  };
  try {
    await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
    await wait(`document.querySelector("#connection")?.textContent === "本地运行中"`, "desktop startup");
    window.unmaximize();
    window.setSize(1280, 850);
    await new Promise(resolve => setTimeout(resolve, 400));
    await evaluate(`(() => {
      const button = document.querySelector("#browser-passwords");
      const badge = document.querySelector("#password-badge");
      const initial = button.getBoundingClientRect();
      for (const label of ["1", "9", "9+"]) {
        badge.textContent = label;
        badge.hidden = false;
        const box = button.getBoundingClientRect();
        const glyph = button.querySelector("svg").getBoundingClientRect();
        const count = badge.getBoundingClientRect();
        if (box.width !== initial.width || box.height !== initial.height ||
          Math.abs(glyph.x + glyph.width / 2 - box.x - box.width / 2) > 1 ||
          Math.abs(glyph.y + glyph.height / 2 - box.y - box.height / 2) > 1 ||
          count.top >= box.top + box.height / 2 || count.left <= box.left + box.width / 2 ||
          count.width < badge.scrollWidth) throw new Error("Credential badge layout shifted: " + label);
      }
      badge.hidden = true;
      if (badge.getBoundingClientRect().width !== 0) throw new Error("Empty credential badge visible");
      badge.textContent = "1";
      badge.hidden = false;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    writeFileSync(join(dirname(output), "credential-badge.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector("#password-badge").hidden = true`);
    checks.credentialBadgeLayout = true;
    await click("#browser-favorites");
    await click('#favorites-panel [aria-label="管理收藏夹"]');
    await wait(`document.querySelector("#library-view").classList.contains("active")`, "library visible");
    checks.startup = true;
    await click('.bm-toolbar [aria-label="新建文件夹"]');
    await fill(".bm-dialog input", "研究资料");
    await fill(".bm-dialog select", "bar");
    await submit();
    let data = await snapshot();
    const folder = data.folders.find(entry => entry.name === "研究资料");
    assert.ok(folder);
    assert.equal(folder.parentId, "bar");
    checks.createFolder = true;

    await click('.bm-toolbar [aria-label="添加书签"]');
    await fill('.bm-dialog input[type="text"]', "研究主页");
    await fill('.bm-dialog input[type="url"]', "https://research.example.test/article");
    await fill(".bm-dialog select", folder.id);
    await submit();
    data = await snapshot();
    const bookmark = data.items.find(entry => entry.pageTitle === "研究主页");
    assert.ok(bookmark);
    assert.equal(bookmark.folderId, folder.id);
    checks.saveBookmark = true;
    await click('.bm-toolbar [aria-label="添加书签"]');
    await fill('.bm-dialog input[type="text"]', "研究主页");
    await fill('.bm-dialog input[type="url"]', bookmark.sourceUrl);
    await fill(".bm-dialog select", folder.id);
    await submit();
    assert.equal((await snapshot()).items.length, 1);
    checks.duplicateSave = true;

    await click(`.bm-row[data-id="${bookmark.id}"] [aria-label="更多操作"]`);
    await click('.bm-popup [aria-label="编辑"]');
    await fill('.bm-dialog input[type="text"]', "已编辑的研究主页");
    await fill('.bm-dialog input[type="url"]', "https://research.example.test/updated?x=1");
    await submit();
    assert.equal((await snapshot()).items[0].sourceUrl, "https://research.example.test/updated?x=1");
    checks.editUrl = true;
    await fill(".bm-search", "updated?x");
    assert.equal(await evaluate(`document.querySelectorAll(".bm-row").length`), 1);
    await fill(".bm-search", "");
    checks.search = true;

    await click(`.bm-row[data-id="${bookmark.id}"] [aria-label="更多操作"]`);
    await click('.bm-popup [aria-label="移动"]');
    await fill(".bm-dialog select", "bar");
    await submit();
    assert.equal((await snapshot()).items[0].folderId, "bar");
    checks.move = true;

    await evaluate(`(async () => {
      for (let i = 0; i < 15; i++) await window.egoDesktop.invoke("collection.bookmark", { title: "常用网站 " + i, url: "https://site" + i + ".example.test", folderId: "bar" });
      await window.egoDesktop.invoke("collection.save", { text: "独立的文字摘录", sourceUrl: "https://research.example.test/updated?x=1" });
    })()`);
    await wait(`document.querySelector("#collection-result-count")?.textContent === "17 项"`, "library event refresh");
    await click('.bm-tree [aria-label="文字摘录"]');
    assert.equal(await evaluate(`document.querySelectorAll(".bm-row").length`), 1);
    checks.excerptsSeparate = true;
    await click('.bm-tree [aria-label="全部收藏"]');
    await click('[data-open-view="start"]');
    await wait(`document.querySelector("#favorites-list [aria-label='更多收藏']") && !document.querySelector("#favorites-list [aria-label='更多收藏']").hidden`, "bar overflow");
    await click('#favorites-list [aria-label="更多收藏"]');
    assert.ok(await evaluate(`document.querySelectorAll(".bm-popup button").length > 0`));
    assert.ok(await evaluate(`(() => {
      const button = document.querySelector('#favorites-list [aria-label="更多收藏"]').getBoundingClientRect();
      const list = document.querySelector("#favorites-list").getBoundingClientRect();
      return button.left >= list.left && button.right <= list.right + 1;
    })()`), "overflow button is inside the visible bar");
    checks.overflow = true;
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await click('[data-open-view="library"]');

    await click(`.bm-row[data-id="${bookmark.id}"] [aria-label="更多操作"]`);
    await click('.bm-popup [aria-label="移至最近删除"]');
    await wait(`document.querySelector("#confirm-dialog")?.open`, "delete confirmation");
    await click("#confirm-accept");
    await wait(`!document.querySelector('.bm-row[data-id="${bookmark.id}"]')`, "deleted item hidden");
    await click('.bm-tree [aria-label="最近删除"]');
    await click(`.bm-row[data-id="${bookmark.id}"] [aria-label="更多操作"]`);
    await click('.bm-popup [aria-label="恢复"]');
    await wait(`!document.querySelector('.bm-row[data-id="${bookmark.id}"]')`, "restore complete");
    assert.ok(!(await snapshot()).items.find(entry => entry.id === bookmark.id).deletedAt);
    checks.restore = true;

    data = await snapshot();
    const html = libraryToBookmarksHtml(data.items.filter(entry => entry.kind === "bookmark"), data.folders);
    const parsed = await evaluate(`(${parseBookmarksDocument.toString()})(${JSON.stringify(html)})`);
    assert.equal(parsed.entries.length, 16);
    assert.ok(parsed.folders.find(entry => entry.name === "研究资料"));
    checks.htmlRoundTrip = true;
    const jsonFile = join(dirname(output), "roundtrip.json");
    const htmlFile = join(dirname(output), "roundtrip.html");
    await evaluate(`window.egoDesktop.invoke("collection.export", { format: "json", testPath: ${JSON.stringify(jsonFile)} })`);
    await evaluate(`window.egoDesktop.invoke("collection.export", { format: "bookmarks-html", testPath: ${JSON.stringify(htmlFile)} })`);
    const imported = await evaluate(`window.egoDesktop.invoke("collection.importFile", { testPath: ${JSON.stringify(jsonFile)} })`);
    assert.equal(imported.added, 0);
    checks.fileRoundTrip = true;

    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
    await click('[data-open-view="start"]');
    await fill("#current-address", fixtureUrl);
    await evaluate(`document.querySelector("#browser-address-form").requestSubmit()`);
    await wait(`document.querySelector("#task-dialog")?.open`, "new task required");
    await fill("#task-name", "Bookmark verification");
    await evaluate(`document.querySelector("#task-form").requestSubmit()`);
    await wait(`!document.querySelector("#task-dialog").open`, "task created");
    await fill("#current-address", fixtureUrl);
    await evaluate(`document.querySelector("#browser-address-form").requestSubmit()`);
    await wait(`document.querySelector("#current-address").value === ${JSON.stringify(fixtureUrl)} && !document.querySelector("#save-page").disabled`, "fixture navigation");
    await wait(`document.querySelector("#browser-tab-list")?.textContent.includes("Bookmark fixture")`, "page title ready");
    await evaluate(`document.querySelector("#save-page").click(); document.querySelector("#save-page").click()`);
    await wait(`document.querySelector(".bm-dialog[open]")`, "quick save panel");
    assert.equal((await snapshot()).items.filter(item => item.sourceUrl === fixtureUrl).length, 1);
    await fill(".bm-dialog select", folder.id);
    await submit();
    await click("#save-page");
    await wait(`document.querySelector(".bm-dialog[open]")`, "edit saved page");
    assert.equal((await snapshot()).items.filter(item => item.sourceUrl === fixtureUrl).length, 1);
    assert.equal(await evaluate(`document.querySelector(".bm-dialog[open]").matches(":modal")`), false);
    assert.equal(await evaluate(`document.querySelector(".bm-dialog[open] details").open`), false);
    await click('.bm-dialog [aria-label="新建文件夹"]');
    await fill('.bm-dialog [aria-label="新文件夹名称"]', "快速分类");
    await click('.bm-dialog [aria-label="创建文件夹"]');
    await wait(`document.querySelector(".bm-dialog[open] .bm-inline-folder").hidden`, "inline folder created");
    const inlineFolder = (await snapshot()).folders.find(item => item.name === "快速分类");
    assert.ok(inlineFolder);
    assert.equal(inlineFolder.parentId, folder.id);
    assert.equal(await evaluate(`document.querySelector(".bm-dialog[open] select").value`), inlineFolder.id);
    await wait(`document.querySelector("#save-page").classList.contains("active")`, "saved star state");
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(await evaluate(`(() => {
      const dialog = document.querySelector(".bm-dialog[open]");
      const rect = dialog.getBoundingClientRect();
      return rect.width > 250 && rect.left >= 0 && rect.right <= innerWidth &&
        document.elementFromPoint(rect.left + 20, rect.top + 20)?.closest(".bm-dialog") === dialog;
    })()`), "quick save is visible above page content");
    writeFileSync(join(dirname(output), "save-panel.png"), (await window.webContents.capturePage()).toPNG());
    await submit();
    assert.equal((await snapshot()).items.find(item => item.sourceUrl === fixtureUrl).folderId, inlineFolder.id);
    checks.addressSaveAndEdit = true;
    checks.compactSaveAndInlineFolder = true;
    await click('[data-open-view="library"]');
    await click('.bm-tree [aria-label="全部收藏"]');
    const current = (await snapshot()).items.find(item => item.sourceUrl === fixtureUrl);
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-ego-bookmarks", JSON.stringify([${JSON.stringify(current.id)}]));
      document.querySelector('.bm-tree [aria-label="其他收藏"]').dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    })()`);
    await wait(`window.egoDesktop.invoke("collection.library").then(data => data.items.find(item => item.id === ${JSON.stringify(current.id)})?.folderId === "other")`, "drag folder move");
    checks.dragMove = true;
    await click('.bm-tree [aria-label="全部收藏"]');
    await evaluate(`document.querySelector(".bm-row").focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"F2", bubbles:true}))`);
    await wait(`document.querySelector(".bm-dialog[open]")`, "keyboard edit");
    await click('.bm-dialog [aria-label="关闭"]');
    await evaluate(`document.querySelector(".bm-row").focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"a", ctrlKey:true, bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelectorAll(".bm-row.is-selected").length`), 18);
    await click('.bm-batch [aria-label="选择当前结果"]');
    checks.managerKeyboard = true;
    window.unmaximize();
    window.setSize(1280, 850);
    await new Promise(resolve => setTimeout(resolve, 300));
    writeFileSync(join(dirname(output), "desktop.png"), (await window.webContents.capturePage()).toPNG());
    window.setSize(800, 650);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(await evaluate("innerWidth <= 800"), "compact viewport actually resized");
    await evaluate(`(() => {
      const button = document.querySelector("#browser-passwords");
      const badge = document.querySelector("#password-badge");
      badge.hidden = false;
      badge.textContent = "9+";
      const box = button.getBoundingClientRect();
      const glyph = button.querySelector("svg").getBoundingClientRect();
      const count = badge.getBoundingClientRect();
      if (Math.abs(glyph.y + glyph.height / 2 - box.y - box.height / 2) > 1 ||
        count.right > innerWidth || count.bottom > box.bottom) throw new Error("Compact credential badge overflow");
      badge.hidden = true;
    })()`);
    assert.ok(await evaluate(`(() => { const row = document.querySelector(".bm-row"); return row && row.getBoundingClientRect().right <= innerWidth; })()`));
    writeFileSync(join(dirname(output), "compact.png"), (await window.webContents.capturePage()).toPNG());
    checks.compactLayout = true;
    window.setSize(1280, 850);
    await click('[data-open-view="start"]');
    await click("#favorites-all");
    assert.ok(await evaluate(`document.querySelector(".bm-folder-popup:not([hidden])") && document.querySelector("#start-view.active")`));
    assert.ok(await evaluate(`document.querySelector(".bm-folder-popup").textContent.includes("Bookmark fixture")`));
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape"}))`);
    checks.otherFolderDropdown = true;
    await click("#browser-favorites");
    await click('#favorites-panel [aria-label="搜索收藏"]');
    await fill('#favorites-panel input', "Bookmark fixture");
    assert.equal(await evaluate(`document.querySelectorAll("#favorites-panel [role=treeitem]").length`), 1);
    await fill('#favorites-panel input', "");
    await click('#favorites-panel [aria-label="搜索收藏"]');
    await evaluate(`document.querySelector('#favorites-panel [data-entry-id="bar"]').dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowLeft", bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#favorites-panel [data-entry-id="bar"]').getAttribute("aria-expanded")`), "false");
    await click('#favorites-panel [data-entry-id="bar"]');
    await new Promise(resolve => setTimeout(resolve, 300));
    writeFileSync(join(dirname(output), "favorites-flyout.png"), (await window.webContents.capturePage()).toPNG());
    checks.flyoutSearchAndTree = true;
    await click('#favorites-panel [aria-label="固定收藏夹"]');
    await wait(`document.querySelector(".bm-panel.is-pinned")`, "panel pinned");
    assert.ok(await evaluate(`(() => {
      const page = document.querySelector(".webview-stack").getBoundingClientRect();
      const panel = document.querySelector("#favorites-panel").getBoundingClientRect();
      return page.right <= panel.left + 1 && page.width > 300;
    })()`), "pinned panel reserves page space");
    await new Promise(resolve => setTimeout(resolve, 250));
    writeFileSync(join(dirname(output), "favorites-pinned.png"), (await window.webContents.capturePage()).toPNG());
    checks.pinnedLayout = true;
    window.setSize(800, 650);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate(`document.querySelector("#favorites-panel").classList.contains("is-pinned")`), false);
    assert.ok(await evaluate(`document.querySelector("#favorites-panel").getBoundingClientRect().right <= innerWidth`));
    writeFileSync(join(dirname(output), "favorites-compact.png"), (await window.webContents.capturePage()).toPNG());
    await click('#favorites-panel [aria-label="取消固定收藏夹"]');
    await evaluate(`document.querySelector("#current-address").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector("#favorites-panel").hidden`), true);
    checks.compactPanelAndDismissal = true;
    window.webContents.sendInputEvent({type:"keyDown", keyCode:"O", modifiers:["control", "shift"]});
    window.webContents.sendInputEvent({type:"keyUp", keyCode:"O", modifiers:["control", "shift"]});
    await wait(`!document.querySelector("#favorites-panel").hidden`, "favorites native shortcut");
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape"}))`);
    assert.equal(await evaluate(`document.activeElement.id`), "browser-favorites");
    window.webContents.sendInputEvent({type:"keyDown", keyCode:"B", modifiers:["control", "shift"]});
    window.webContents.sendInputEvent({type:"keyUp", keyCode:"B", modifiers:["control", "shift"]});
    await wait(`document.querySelector("#favorites-bar").hidden`, "bar hidden shortcut");
    window.webContents.sendInputEvent({type:"keyDown", keyCode:"B", modifiers:["control", "shift"]});
    window.webContents.sendInputEvent({type:"keyUp", keyCode:"B", modifiers:["control", "shift"]});
    await wait(`!document.querySelector("#favorites-bar").hidden`, "bar restored shortcut");
    checks.nativeFavoritesShortcuts = true;
    assert.deepEqual(errors.filter(message => !/favicon|ERR_NAME_NOT_RESOLVED/.test(message)), []);
    writeFileSync(output, JSON.stringify({ passed: true, checks, errors }, null, 2));
    await new Promise(resolve => fixture.close(resolve));
    exit(0);
  } catch (error) {
    const dialogs = await evaluate(`[...document.querySelectorAll(".bm-dialog")].map(d => ({html:d.outerHTML, fields:[...d.querySelectorAll("input,select")].map(x=>({value:x.value,type:x.type}))}))`).catch(() => []);
    writeFileSync(output, JSON.stringify({ passed: false, checks, error: error.stack, errors, dialogs }, null, 2));
    try { writeFileSync(join(dirname(output), "failure.png"), (await window.webContents.capturePage()).toPNG()); } catch {}
    await new Promise(resolve => fixture.close(resolve));
    exit(1);
  }
}
