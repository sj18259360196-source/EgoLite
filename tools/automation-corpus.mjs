import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { AutomationRunner } from "../apps/ego-mcp-server/src/automation/runner.ts";
import { runSchema, extractSchema } from "../apps/ego-mcp-server/src/automation/schema.ts";

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const visible = target => ({ kind: "visible", target });
const field = (target, value) => ({ kind: "value_equals", target, value });
const click = target => ({ action: "click", target });
const fill = (target, valueKey) => ({ action: "fill", target, valueKey });

// Synthetic public data only. Each navigation resets the entire fixture.
export function automationCorpus() {
  const tasks = [];
  for (const locale of ["en", "zh"]) {
    const zh = locale === "zh";
    const reports = zh ? "\u62a5\u8868" : "Reports";
    const names = zh ? ["\u9500\u552e", "\u5e93\u5b58", "\u8bbf\u95ee"] : ["Sales", "Inventory", "Visits"];
    const next = zh ? "\u4e0b\u4e00\u9875" : "Next";
    const proceed = zh ? "\u7ee7\u7eed" : "Continue";
    for (let variant = 0; variant < 3; variant++) {
      const id = kind => `${locale}-${kind}-${variant + 1}`;
      const expected = names[variant];
      tasks.push({
        id: id("menu"), kind: "menu", locale,
        goal: zh ? `\u6253\u5f00${reports}\u83dc\u5355\uff0c\u67e5\u770b${expected}\u62a5\u8868` : `Open the Reports menu and view the ${expected} report`,
        body: `<button id="menu" onclick="document.querySelector('#choices').hidden=false">${reports}</button>
          <section id="choices" hidden>${names.map((name, index) => `<button id="report-${index}" onclick="document.querySelector('#result').textContent=this.textContent;document.querySelector('#result').hidden=false">${name}</button>`).join("")}</section>
          <output id="result" hidden></output>`,
        values: {}, steps: [click("#menu"), click(`#report-${variant}`)],
        success: { all: [visible("#result"), { kind: "text_contains", target: "#result", value: expected }] },
        inspect: `({visible:!document.querySelector("#result").hidden,text:document.querySelector("#result").textContent})`,
        expected: { visible: true, text: expected },
      });
      const values = { name: `Reader ${variant + 1}`, city: ["Shanghai", "Hangzhou", "Nanjing"][variant] };
      const nameLabel = zh ? "\u59d3\u540d" : "Name";
      const cityLabel = zh ? "\u57ce\u5e02" : "City";
      tasks.push({
        id: id("form"), kind: "form", locale,
        goal: zh ? "\u586b\u5199\u63d0\u4f9b\u7684\u59d3\u540d\u548c\u57ce\u5e02\uff0c\u7136\u540e\u7ee7\u7eed" : "Fill the supplied name and city, then continue",
        body: `<label>${nameLabel}<input id="name" aria-label="${nameLabel}"></label>
          <label>${cityLabel}<input id="city" aria-label="${cityLabel}"></label>
          <button id="continue" onclick="if(document.querySelector('#name').value&&document.querySelector('#city').value)document.querySelector('#done').hidden=false">${proceed}</button><output id="done" hidden>OK</output>`,
        values, steps: [fill("#name", "name"), fill("#city", "city"), click("#continue")],
        success: { all: [visible("#done"), field("#name", values.name), field("#city", values.city)] },
        inspect: `({visible:!document.querySelector("#done").hidden,name:document.querySelector("#name").value,city:document.querySelector("#city").value})`,
        expected: { visible: true, ...values },
      });
      const category = ["books", "tools", "music"][variant];
      const categories = zh ? ["\u56fe\u4e66", "\u5de5\u5177", "\u97f3\u4e50"] : ["Books", "Tools", "Music"];
      const categoryLabel = zh ? "\u5206\u7c7b" : "Category";
      const activeLabel = zh ? "\u4ec5\u663e\u793a\u542f\u7528\u9879" : "Active only";
      const apply = zh ? "\u5e94\u7528\u7b5b\u9009" : "Apply filters";
      tasks.push({
        id: id("filter"), kind: "filter", locale,
        goal: zh ? `\u7b5b\u9009${categories[variant]}\u5206\u7c7b\uff0c\u4ec5\u663e\u793a\u542f\u7528\u9879\uff0c\u5e76\u5e94\u7528\u7b5b\u9009` : `Select the ${categories[variant]} category, enable Active only, and apply filters`,
        body: `<label>${categoryLabel}<select id="category" aria-label="${categoryLabel}"><option value="">All</option>${["books", "tools", "music"].map((key, index) => `<option value="${key}">${categories[index]}</option>`).join("")}</select></label>
          <label><input id="active" type="checkbox">${activeLabel}</label>
          <button id="apply" onclick="document.querySelector('#result').textContent=document.querySelector('#category').value+':'+document.querySelector('#active').checked">${apply}</button><output id="result"></output>`,
        values: { category }, steps: [{ action: "select", target: "#category", valueKey: "category" }, { action: "check", target: "#active" }, click("#apply")],
        success: { all: [field("#category", category), { kind: "checked", target: "#active", value: true }, { kind: "text_contains", target: "#result", value: `${category}:true` }] },
        inspect: `({category:document.querySelector("#category").value,active:document.querySelector("#active").checked,result:document.querySelector("#result").textContent})`,
        expected: { category, active: true, result: `${category}:true` },
      });
      const pages = Array.from({ length: variant + 2 }, (_, page) => Array.from({ length: 2 }, (_, row) => `${locale}-record-${page * 2 + row + 1}`));
      tasks.push({
        id: id("pagination"), kind: "pagination", locale, goal: zh ? "\u8bfb\u53d6\u6240\u6709\u5206\u9875\u8bb0\u5f55" : "Read every record across all pages",
        body: `<table><tbody id="rows"></tbody></table><button id="next">${next}</button>
          <script>const pages=${JSON.stringify(pages)};let page=0;function render(){document.querySelector("#rows").replaceChildren(...pages[page].map(text=>{const tr=document.createElement("tr");const td=document.createElement("td");td.textContent=text;tr.append(td);return tr}));document.querySelector("#next").disabled=page===pages.length-1}document.querySelector("#next").onclick=()=>{page++;render()};render();</script>`,
        extract: { selector: "#rows tr", fields: { name: { selector: "td", attribute: "text" } }, next: "#next", maxPages: 6 },
        expected: pages.flat().map(name => ({ name })),
      });
    }
  }
  return tasks;
}

export function corpusPage(pathname) {
  const task = automationCorpus().find(item => pathname === `/corpus/${item.id}`);
  if (!task) return undefined;
  return `<!doctype html><html lang="${task.locale}"><head><meta charset="utf-8"><title>${escape(task.id)}</title></head>
    <body><main>${task.body}</main><script>
      window.__automationEvents=[];
      for(const type of ["mousedown","mouseup","click"])document.addEventListener(type,event=>{
        window.__automationEvents.push({type,target:event.target.id,trusted:event.isTrusted,x:event.clientX,y:event.clientY});
        if(window.__automationEvents.length>30)window.__automationEvents.shift();
      },true);
    </script></body></html>`;
}

export function summarizeSamples(samples) {
  const times = samples.map(sample => sample.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    attempts: samples.length, successes: samples.filter(sample => sample.success).length,
    failures: samples.filter(sample => !sample.success).length,
    falseCompletions: samples.filter(sample => sample.falseCompletion).length,
    medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
    p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
    modelRequests: samples.reduce((total, sample) => total + (sample.result?.metrics?.requestAttempts || 0), 0),
    inputTokens: samples.reduce((total, sample) => total + (sample.result?.metrics?.inputTokens || 0), 0),
    unknownUsageAttempts: samples.reduce((total, sample) => total + (sample.result?.metrics?.unknownUsageAttempts || 0), 0),
    unresolvedDecisions: samples.reduce((total, sample) => total + (sample.result?.metrics?.unresolvedDecisions || 0), 0),
  };
}

async function sdkTask(page, task) {
  if (task.extract) {
    const rows = [];
    for (let index = 0; index < task.extract.maxPages; index++) {
      rows.push(...await page.evaluate(`Array.from(document.querySelectorAll("#rows tr"),row=>({name:row.querySelector("td").textContent}))`));
      if (await page.evaluate('document.querySelector("#next").disabled')) break;
      await page.locator("#next").click();
    }
    return rows;
  }
  for (const step of task.steps) {
    const locator = page.locator(step.target);
    if (step.action === "fill") await locator.fill(task.values[step.valueKey]);
    else if (step.action === "select") await locator.selectOption(task.values[step.valueKey]);
    else if (step.action === "check") await locator.check();
    else await locator.click();
  }
}

export async function benchmarkCorpus(pipe, baseUrl, { live = false, repeats = 3, taskFilter = "", checkpoint = () => {} } = {}) {
  if (!Number.isInteger(repeats) || repeats < 3 || repeats > 10) throw new Error("Corpus needs 3-10 repeats");
  const tasks = automationCorpus().filter(task => task.id.includes(taskFilter));
  if (!tasks.length) throw new Error("Corpus filter matched no tasks");
  const cold = performance.now();
  const session = await EgoMcpSession.connect(pipe, { autoStartDesktop: false });
  const arms = live ? ["sdk", "direct", "jev"] : ["sdk", "direct"];
  const report = {
    scope: "Synthetic local browser execution. SDK baseline is a composed workflow. Codex reasoning time, token usage and roundtrips are not measured; this is not the end-to-end release benchmark.",
    provider: live ? "TypeSafe live API" : "no model requests",
    tasks: tasks.map(({ id, kind, locale }) => ({ id, kind, locale })), repeats, taskFilter,
    coldStartMs: null, samples: [], summaries: {}, codexMetrics: null,
    sourceHashes: Object.fromEntries([
      "./automation-corpus.mjs", "../apps/ego-mcp-server/src/automation/runner.ts",
      "../apps/ego-mcp-server/src/automation/page-data.ts", "../apps/desktop-shell/automation-decision-service.mjs",
      "../vendor/ego-browser/src/driver/pointer.js",
    ].map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")])),
  };
  try {
    await session.sdk.taskSpaces.useOrCreate("Automation corpus benchmark");
    await session.sdk.browser.openOrReuseTab(baseUrl, { wait: true });
    report.coldStartMs = performance.now() - cold;
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const [taskIndex, task] of tasks.entries()) {
        const offset = (repeat + taskIndex) % arms.length;
        for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) {
          const sample = { task: task.id, kind: task.kind, locale: task.locale, repeat, arm, success: false, falseCompletion: false };
          let started;
          try {
            const reset = performance.now();
            await session.sdk.page.goto(new URL(`/corpus/${task.id}`, baseUrl).href, { waitUntil: "load", timeout: 15000 });
            sample.resetMs = performance.now() - reset;
            if (!task.extract) assert.notDeepEqual(await session.sdk.page.evaluate(task.inspect), task.expected, "Fixture starts completed");
            started = performance.now();
            let rows;
            if (arm === "sdk") rows = await sdkTask(session.sdk.page, task);
            else {
              const runner = new AutomationRunner();
              sample.result = task.extract
                ? await runner.extract(session, extractSchema.parse(task.extract))
                : await runner.run(session, runSchema.parse({
                  goal: task.goal, values: task.values, steps: arm === "direct" ? task.steps : [],
                  mode: arm === "direct" ? "direct" : "auto", success: task.success,
                  allowedOrigins: [baseUrl], budget: { timeoutMs: 15000, maxDecisions: 10, maxActions: 12 },
                }));
              rows = sample.result.rows;
            }
            const actual = task.extract ? rows : await session.sdk.page.evaluate(task.inspect);
            let verified = true;
            try { assert.deepEqual(actual, task.expected); } catch { verified = false; }
            const claimed = sample.result && (sample.result.status === "done" || sample.result.complete === true);
            sample.falseCompletion = Boolean(claimed && !verified);
            sample.success = verified && (arm === "sdk" || Boolean(claimed));
            if (!sample.success) sample.error = sample.result?.reason || "independent_verification_failed";
          } catch (error) {
            sample.error = String(error?.message || error).slice(0, 2000);
            if (started === undefined) sample.phase = "reset";
          } finally {
            sample.elapsedMs = started === undefined ? null : performance.now() - started;
            if (!sample.success && started !== undefined) {
              try { sample.browserDiagnostic = await session.sdk.page.evaluate('({focused:document.hasFocus(),visibility:document.visibilityState,events:window.__automationEvents})'); } catch {}
            }
            report.samples.push(sample);
            report.summaries = Object.fromEntries(arms.map(name => [name, summarizeSamples(report.samples.filter(item => item.arm === name))]));
            checkpoint(report);
          }
        }
      }
    }
    report.passed = report.samples.length === tasks.length * repeats * arms.length && report.samples.every(sample => sample.success && !sample.falseCompletion);
    return report;
  } finally { await session.close(); }
}
