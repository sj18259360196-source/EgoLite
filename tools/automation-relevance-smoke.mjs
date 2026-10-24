import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function relevancePage(path) {
  const zh = path.endsWith("/zh");
  const rows = Array.from({ length: 60 }, (_, index) => {
    const relevant = index % 3 === 0;
    return {
      title: `${relevant ? (zh ? "\u6d4f\u89c8\u5668\u81ea\u52a8\u5316\u6d4b\u8bd5\u5de5\u5177" : "Browser automation testing toolkit")
        : (zh ? "\u53a8\u623f\u98df\u8c31\u6536\u85cf" : "Kitchen recipe collection")} ${index}`,
      summary: relevant
        ? (zh ? "\u7528\u4e8e\u7f51\u9875\u8868\u5355\u3001\u94fe\u63a5\u5bfc\u822a\u548c\u5206\u9875\u91c7\u96c6\u7684\u81ea\u52a8\u5316\u6d4b\u8bd5\u3002\u901a\u8fc7\u7ed3\u6784\u5316\u9875\u9762\u72b6\u6001\u68c0\u67e5\u6267\u884c\u7ed3\u679c\uff0c\u652f\u6301\u53d6\u6d88\u548c\u5931\u8d25\u62a5\u544a\u3002"
          : "Automates browser forms, link navigation and paginated data collection. Includes structured page-state assertions, cancellation and failure reports for repeatable web application tests.")
        : (zh ? "\u8bb0\u5f55\u5bb6\u5e38\u83dc\u7684\u98df\u6750\u3001\u6e29\u5ea6\u548c\u70f9\u996a\u65f6\u95f4\uff0c\u5305\u62ec\u9762\u5305\u3001\u6c64\u548c\u6c99\u62c9\u7684\u505a\u6cd5\u3002\u8fd9\u662f\u4e00\u672c\u7eb8\u8d28\u83dc\u8c31\u7684\u6761\u76ee\uff0c\u4e0e\u8f6f\u4ef6\u3001\u6d4f\u89c8\u5668\u6d4b\u8bd5\u6216\u81ea\u52a8\u5316\u65e0\u5173\u3002"
          : "Lists ingredients, oven temperatures and cooking times for bread, soups and salads. This is a printed cookbook entry, unrelated to software, browser testing or automation."),
      href: `/record/${index}`,
    };
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Relevance fixture</title></head><body>
  <table><tbody id="rows"></tbody></table><button id="next">Next page</button>
  <script>
  const rows=${JSON.stringify(rows)};let page=0;
  function render(){const body=document.querySelector("#rows");body.replaceChildren();
    for(const item of rows.slice(page*20,(page+1)*20)){const tr=document.createElement("tr");
      for(const field of ["title","summary"]){const td=document.createElement("td");td.className=field;td.textContent=item[field];tr.append(td);}
      const td=document.createElement("td"),a=document.createElement("a");a.href=item.href;a.textContent="Details";td.append(a);tr.append(td);body.append(tr);}
    document.querySelector("#next").disabled=page===2;}
  document.querySelector("#next").onclick=()=>{page++;render();};render();
  </script></body></html>`;
}

const extraction = {
  selector: "#rows tr",
  fields: { title: { selector: ".title" }, summary: { selector: ".summary" }, href: { selector: "a", attribute: "href" } },
  next: "#next", maxPages: 3, maxRows: 60,
};
const relevance = lang => ({
  query: lang === "zh" ? "\u627e\u7528\u4e8e\u6d4f\u89c8\u5668\u81ea\u52a8\u5316\u6d4b\u8bd5\u7684\u8f6f\u4ef6\u5de5\u5177" : "Find software tools for browser automation testing",
  fields: ["title", "summary"], batchSize: 20,
});
const expected = Array.from({ length: 20 }, (_, i) => i * 3);
const rowIds = rows => rows.map(row => Number(new URL(row.href).pathname.split("/").at(-1)));

export async function probeRelevance(call, baseUrl, { pipe, checkpoint = () => {} }) {
  const samples = [];
  await call("ego_task_use", { task: "Relevance verification" });
  for (const lang of ["en", "zh"]) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const sample = { lang, repeat };
      samples.push(sample);
      for (const arm of repeat % 2 ? ["filtered", "plain"] : ["plain", "filtered"]) {
        await call("ego_open", { url: new URL(`/relevance/${lang}`, baseUrl).href });
        await call("ego_navigate", { action: "reload" });
        const started = performance.now();
        const result = await call("ego_extract", { ...extraction, ...(arm === "filtered" ? { relevance: relevance(lang) } : {}) });
        sample[arm] = { result, elapsedMs: Math.round(performance.now() - started),
          rowBytes: Buffer.byteLength(JSON.stringify(result.rows)), responseBytes: Buffer.byteLength(JSON.stringify(result)) };
        checkpoint({ samples });
        if (arm === "plain") {
          assert.equal(result.rows.length, 60);
          assert.equal(result.metrics.decisions, 0);
        } else {
          assert.equal(result.relevance.complete, true);
          assert.equal(result.relevance.unknownRows, 0);
          assert.equal(result.relevance.excludedRows, 40);
          assert.equal(result.metrics.decisions, 3);
          assert.deepEqual(result.relevance.rowIndices, expected);
          assert.deepEqual(rowIds(result.rows), expected);
          assert.deepEqual(result.relevance.judgments.map(item => item.sourceIndex), Array.from({ length: 60 }, (_, i) => Math.floor(i / 20)));
        }
        assert.equal(result.complete, true);
        assert.equal(result.status, "done");
        assert.equal(result.sources.length, 3);
        assert.equal(result.metrics.actions, 2);
      }
      checkpoint({ samples });
    }
  }
  await call("ego_open", { url: new URL("/relevance/en", baseUrl).href });
  await call("ego_navigate", { action: "reload" });
  const partial = await call("ego_extract", { ...extraction, relevance: { ...relevance("en"), maxDecisions: 1 } });
  assert.equal(partial.complete, true);
  assert.equal(partial.relevance.complete, false);
  assert.equal(partial.relevance.unknownRows, 40);
  assert.equal(partial.metrics.decisions, 1);
  assert.ok(Array.from({ length: 40 }, (_, i) => i + 20).every(index => partial.relevance.rowIndices.includes(index)));
  assert.equal(partial.status, "needs_reasoning");

  const source = `
    await taskSpaces.useOrCreate("SDK relevance verification");
    await browser.openOrReuseTab(${JSON.stringify(new URL("/relevance/en", baseUrl).href)}, {wait:true});
    console.log(JSON.stringify(await automation.extract(${JSON.stringify({ ...extraction, relevance: relevance("en") })})));
  `;
  const env = { ...process.env, EGO_COMPAT_PIPE: pipe, EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_BROWSER_AGENT_ID: "sdk-relevance-smoke" };
  for (const key of ["TYPESAFE_API_KEY", "CODEX_THREAD_ID", "CODEX_SESSION_ID"]) delete env[key];
  const child = spawn(process.execPath, ["apps/ego-browser/src/main.ts"], {
    cwd: resolve(import.meta.dirname, ".."), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timeout = setTimeout(() => child.kill(), 60000);
  child.stdin.end(source);
  let sdk;
  try {
    assert.equal(await exit, 0, stderr);
    sdk = JSON.parse(stdout.trim());
    assert.equal(sdk.status, "done");
    assert.equal(sdk.metrics.decisions, 3);
    assert.deepEqual(rowIds(sdk.rows), expected);
  } finally { clearTimeout(timeout); }
  return { passed: true, scope: "Synthetic local pages in real EgoLite; not public-site or Codex end-to-end timing", samples, partial, sdk };
}
