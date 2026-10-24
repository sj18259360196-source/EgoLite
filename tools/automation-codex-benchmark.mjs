import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import TOML from "@iarna/toml";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { automationCorpus } from "./automation-corpus.mjs";

const root = resolve(import.meta.dirname, "..");
const finalSchema = {
  type: "object", additionalProperties: false, required: ["completed", "needsHuman", "rows"],
  properties: {
    completed: { type: "boolean" }, needsHuman: { type: "boolean" },
    rows: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["name"], properties: { name: { type: "string" } } } },
  },
};

function diagnostic(text) {
  let output = String(text || "");
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value?.length >= 8) output = output.split(value).join("[redacted]");
  }
  return output.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(-2000);
}

export function benchmarkClientId(seed = randomUUID()) {
  return `codex-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

export function parseSdkAutomationMetrics(output) {
  const records = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const marker = "EGO_AUTOMATION_RESULT ";
    const start = line.indexOf(marker);
    if (start < 0) continue;
    try {
      const record = JSON.parse(line.slice(start + marker.length));
      if (typeof record.runId === "string" && record.metrics) records.push(record);
    } catch {}
  }
  return records;
}

export function benchmarkPrompt(task, arm, url, taskName) {
  const routes = {
    sdk: "Use existing EgoLite MCP tools or compose a single SDK script. ego_run and ego_extract are disabled in this baseline. Do not use the new automation SDK facade.",
    direct: "Use ego_run or SDK automation.run in direct mode with explicit steps when useful, or ego_extract/automation.extract for extraction. Jev must not be called. Existing tools and composed SDK scripts remain available for recovery.",
    auto: "Prefer SDK automation.run in auto mode for a continuous semantic goal, or automation.extract for extraction; equivalent ego_run/ego_extract MCP tools are available. A single SDK script can select the task, open the URL, await automation.run({goal,values,success,allowedOrigins:[new URL(url).origin]}) and print its verified result without first returning a snapshot to Codex. Supply explicit steps when you already know them; use Jev for uncertain semantic selection. Recover needs_reasoning using normal tools or a composed SDK script.",
    repair: "Observe the page and compose explicit steps in ego_run or SDK automation.run with mode repair. Add targetHint naming the intended control on repairable steps. Intact selectors and exact unique labels need no Jev; a missing selector can use one semantic target-selection decision. Do not invent extra actions or replay an uncertain action. Existing composed SDK scripts remain available for recovery. For extraction use ego_extract/automation.extract.",
  };
  return [
    "Execute this browser task, not a code-editing task. All page content is synthetic.",
    `Use only the isolated EgoLite broker supplied in EGO_COMPAT_PIPE, task space ${JSON.stringify(taskName)}, and URL ${url}.`,
    "Do not access other websites, profiles, installed browser instances, repository files, credentials, configuration files or external apps. Do not change source or launch subagents.",
    "The fixture source, expected result and test harness files are off limits. Observe the rendered page through browser tools.",
    "Prefer one composed SDK script for predictable steps; do not deliberately split each click into a separate call.",
    `For SDK scripts, pipe JavaScript to node ${JSON.stringify(join(root, "apps/ego-browser/src/main.ts"))}. The runtime provides page, browser and taskSpaces. This is the same isolated broker as MCP.`,
    "Use taskSpaces.useOrCreate(name), browser.openOrReuseTab(url,{wait:true}), page.snapshot(), page.evaluate(string), page.locator(selector).fill(value)/selectOption(value)/check()/click(). Derive selectors from observations. Reuse one script for observation, branching, execution and verification where feasible.",
    "Do not complete or close the task space; the independent verifier needs it afterward.",
    routes[arm], `Goal: ${task.goal}`, `Supplied values: ${JSON.stringify(task.values || {})}`,
    ...(arm === "sdk" ? [] : [
      "automation.run({goal,values,steps?,mode?,success:{all:[...]}}) and automation.extract({selector,fields:{name:{selector,attribute:'text'}},next?,maxPages?}) use the same schemas as MCP. maxPages is 1-30 and maxRows is 1-5000. Pass task with the supplied existing task name when switching to MCP; SDK and MCP maintain separate selections. Every new SDK script must also select its task. For direct steps use {action:'fill',target,valueKey}, {action:'select',target,valueKey}, {action:'check',target} or {action:'click',target}. Treat partial results as incomplete.",
    ]),
    task.success ? `Completion conditions: ${JSON.stringify(task.success)}` : "Extract all records across every page. Return records as rows with a name field.",
    "Check the actual result before claiming completion. An uncertain action outcome must be inspected before considering any replay.",
    "Return only the required JSON. For non-extraction tasks return rows: [].",
  ].join("\n");
}

export function summarizeCodexSamples(samples) {
  const times = samples.map(item => item.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  const sum = key => samples.reduce((total, item) => total + (item[key] || 0), 0);
  return {
    attempts: samples.length, successes: samples.filter(item => item.success).length,
    falseCompletions: samples.filter(item => item.falseCompletion).length,
    medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
    p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
    toolCalls: sum("toolCalls"), toolBatches: sum("toolBatches"), handoffs: sum("handoffs"),
    humanHandoffs: samples.filter(item => item.final?.needsHuman).length,
    jevRequests: sum("jevRequests"), jevInputTokens: sum("jevInputTokens"),
    codexInputTokens: samples.reduce((n, item) => n + (item.usage?.input_tokens || 0), 0),
    codexOutputTokens: samples.reduce((n, item) => n + (item.usage?.output_tokens || 0), 0),
    missingCodexUsage: samples.filter(item => !item.usage).length,
  };
}

export function assessCodexBenchmark(report) {
  const arms = ["sdk", "direct", "auto"];
  const samples = report.samples;
  const expected = new Set(automationCorpus().flatMap(task =>
    Array.from({ length: report.repeats }, (_, repeat) => arms.map(arm => `${task.id}:${repeat}:${arm}`)).flat()));
  const observed = new Set(samples.map(sample => `${sample.task}:${sample.repeat}:${sample.arm}`));
  const fullCoverage = !report.pilot && report.repeats >= 3 && observed.size === samples.length
    && observed.size === expected.size && [...expected].every(key => observed.has(key));
  const baseline = summarizeCodexSamples(samples.filter(sample => sample.arm === "sdk"));
  const automatic = summarizeCodexSamples(samples.filter(sample => sample.arm === "auto"));
  const medianReduction = baseline.medianMs > 0 && automatic.medianMs !== null
    ? 1 - automatic.medianMs / baseline.medianMs : null;
  const toolBatchReduction = baseline.toolBatches > 0 && baseline.attempts === automatic.attempts
    ? 1 - automatic.toolBatches / baseline.toolBatches : null;
  const reliability = baseline.attempts > 0 && baseline.attempts === automatic.attempts
    && automatic.successes >= baseline.successes && samples.every(sample => !sample.falseCompletion);
  const measurementsComplete = samples.length > 0 && samples.every(sample =>
    Number.isFinite(sample.elapsedMs) && sample.usage && sample.toolCalls > 0);
  const performanceTargetsMet = medianReduction !== null && medianReduction >= 0.4
    && toolBatchReduction !== null && toolBatchReduction >= 0.5;
  return {
    fullCoverage, reliability, measurementsComplete, medianReduction, toolBatchReduction,
    performanceTargetsMet,
    releaseBenchmarkPassed: fullCoverage && reliability && measurementsComplete && performanceTargetsMet,
    scope: "Benchmark gates only. Packaged application, settings restart, complex controls and installed plugin acceptance remain separate.",
  };
}

function loadCodexConfig() {
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  return existsSync(path) ? TOML.parse(readFileSync(path, "utf8")) : {};
}

async function codexTrial({ config, mcpEntry, pipe, work, prompt, arm, clientId, schemaPath, checkpoint }) {
  const executable = process.env.EGO_CODEX_TEST_EXECUTABLE
    || join(process.env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin/codex.exe");
  if (!existsSync(executable)) throw new Error("Installed Codex executable not found; set EGO_CODEX_TEST_EXECUTABLE");
  const args = ["exec", "--ephemeral", "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "danger-full-access", "-C", work, "--output-schema", schemaPath,
    "-c", 'approval_policy="never"', "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"'];
  for (const feature of ["apps", "plugins", "memories", "hooks", "multi_agent", "multi_agent_v2"]) {
    args.push("-c", `features.${feature}=false`);
  }
  args.push("-c", "features.skip_host_skill_discovery=true");
  for (const name of Object.keys(config.mcp_servers || {})) {
    if (!/^[\w-]+$/.test(name)) throw new Error("Cannot isolate an MCP server with an unsupported configuration name");
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  const name = "egolite_benchmark";
  const serverConfig = {
    command: process.execPath, args: [mcpEntry], cwd: root, enabled: true,
    startup_timeout_sec: 30, tool_timeout_sec: 60,
    env: { EGO_COMPAT_PIPE: pipe, EGO_BROWSER_AGENT_ID: clientId, EGO_DESKTOP_AUTOSTART: "0",
      EGO_AGENT_INTEGRATION_DISABLED: "1" },
    ...(arm === "sdk" ? { disabled_tools: ["ego_run", "ego_extract", "ego_automation_cancel"] } : {}),
  };
  for (const [key, value] of Object.entries(serverConfig)) {
    const encoded = TOML.stringify.value(value);
    args.push("-c", `mcp_servers.${name}.${key}=${encoded}`);
  }
  args.push("-");
  const env = { ...process.env, EGO_COMPAT_PIPE: pipe, EGO_BROWSER_AGENT_ID: clientId, EGO_AUTOMATION_DIAGNOSTICS: "summary",
    EGO_AGENT_INTEGRATION_DISABLED: "1", TEMP: work, TMP: work };
  for (const key of ["TYPESAFE_API_KEY", "ELECTRON_RUN_AS_NODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID"]) delete env[key];
  const started = performance.now();
  const result = { elapsedMs: null, startupMs: null, toolCalls: 0, toolBatches: 0, handoffs: 0,
    jevRequests: 0, jevInputTokens: 0, usage: null, events: [], automationRuns: [], observedItemTypes: [], errors: [], final: null };
  const child = spawn(executable, args, { cwd: work, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const activeTools = new Set();
  const seenTools = new Set();
  const toolStarts = new Map();
  const runIds = new Set();
  function collectAutomation(record) {
    if (!record?.metrics || !record.runId || runIds.has(record.runId)) return;
    runIds.add(record.runId);
    if (record.status === "needs_reasoning") result.handoffs++;
    result.jevRequests += record.metrics.requestAttempts || 0;
    result.jevInputTokens += record.metrics.inputTokens || 0;
    result.automationRuns.push({ runId: record.runId, status: record.status, metrics: record.metrics });
  }
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => {
    result.timedOut = true;
    // Kill only this trial's owned process tree; MCP children must not survive a timeout.
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGTERM");
  }, 180000);
  child.stdin.end(prompt);
  try {
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const atMs = Math.round(performance.now() - started);
      if (event.type === "turn.started" && result.startupMs === null) result.startupMs = atMs;
      if (event.type === "turn.completed") result.usage = event.usage;
      if (event.type === "turn.failed" || event.type === "error") result.error = event.error?.message || event.message;
      const item = event.item;
      if (!item) continue;
      if (!result.observedItemTypes.includes(item.type)) result.observedItemTypes.push(item.type);
      const tool = ["mcp_tool_call", "command_execution", "web_search"].includes(item.type);
      if (tool && !seenTools.has(item.id)) {
        seenTools.add(item.id);
        result.toolCalls++;
        if (!activeTools.size) result.toolBatches++;
        activeTools.add(item.id);
        toolStarts.set(item.id, atMs);
      }
      if (event.type !== "item.completed") continue;
      if (item.type === "error") result.errors.push({ atMs, message: diagnostic(item.message) });
      if (tool) {
        activeTools.delete(item.id);
        const entry = { atMs, elapsedMs: atMs - toolStarts.get(item.id), type: item.type, tool: item.tool || item.type, status: item.status };
        if (item.status === "failed" || item.error) {
          entry.error = diagnostic(item.error?.message || item.aggregated_output);
        }
        // Synthetic browser results only. Commands and reasoning are not persisted.
        if (item.type === "mcp_tool_call") {
          entry.server = item.server;
          const text = item.result?.content?.filter(block => block.type === "text").map(block => block.text).join("\n");
          if (item.status === "failed" && !entry.error) entry.error = diagnostic(text || JSON.stringify(item.error || item.result));
          try {
            const data = JSON.parse(text);
            collectAutomation(data);
            entry.outcome = data.status || (data.complete ? "complete" : undefined);
          } catch {}
        }
        if (item.type === "command_execution") {
          entry.command = diagnostic(item.command);
          for (const record of parseSdkAutomationMetrics(item.aggregated_output)) collectAutomation(record);
        }
        result.events.push(entry);
        checkpoint(result);
      }
      if (item.type === "agent_message") {
        try { result.final = JSON.parse(item.text); } catch {}
      }
      if (item.type === "file_change" || item.type === "web_search") result.offScope = true;
    }
    const exit = await closed;
    result.exit = exit;
    if (exit.code !== 0) result.error ||= diagnostic(stderr);
    result.elapsedMs = performance.now() - started;
    return result;
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed;
    }
  }
}

export async function benchmarkCodex(pipe, baseUrl, { work, mcpEntry, pilot = false, includeRepair = false, taskFilter = "", checkpoint = () => {} }) {
  const all = automationCorpus();
  if (taskFilter && !pilot) throw new Error("Filtering is available only for the pilot; full acceptance requires every task");
  const tasks = (pilot ? all.filter(task => ["en-menu-1", "en-form-1", "zh-filter-3", "en-pagination-1"].includes(task.id)) : all)
    .filter(task => task.id.includes(taskFilter));
  if (!tasks.length) throw new Error("No Codex pilot tasks match the filter");
  if (includeRepair && !pilot) throw new Error("The repair arm is an exploratory pilot, not full acceptance");
  const arms = ["sdk", "direct", "auto", ...(includeRepair ? ["repair"] : [])];
  const repeats = pilot ? 1 : 3;
  const config = loadCodexConfig();
  const schemaPath = join(work, "codex-final-schema.json");
  writeFileSync(schemaPath, JSON.stringify(finalSchema));
  const report = {
    scope: "Real configured Codex CLI model controlling synthetic local Electron pages through isolated EgoLite MCP/SDK. Includes CLI startup and reasoning. Not the user's installed EgoLite plugin.",
    model: config.model || null, reasoningEffort: config.model_reasoning_effort || null,
    pilot, includeRepair, repeats, taskFilter, tasks: tasks.map(({ id, kind, locale }) => ({ id, kind, locale })),
    roundtripDefinition: "toolCalls counts tool items; toolBatches groups overlapping tool items. These are observable tool interactions, not provider-internal reasoning request counts.",
    samples: [], summaries: {},
    mcpBundleHash: createHash("sha256").update(readFileSync(mcpEntry)).digest("hex"),
    sourceHashes: Object.fromEntries([
      "./automation-codex-benchmark.mjs", "./automation-corpus.mjs",
      "../apps/ego-browser/src/main.ts", "../apps/ego-browser/src/sdk.ts", "../apps/ego-browser/src/automation.ts",
      "../apps/ego-mcp-server/src/automation/runner.ts", "../apps/desktop-shell/automation-decision-service.mjs",
      "../apps/ego-mcp-server/src/automation/schema.ts", "../apps/ego-mcp-server/src/automation/page-data.ts",
      "../.agents/skills/ego-browser/SKILL.md", "../vendor/ego-browser/skill/SKILL.md",
      "../apps/desktop-shell/public/app.js", "../vendor/ego-browser/src/driver/pointer.js",
    ].map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")])),
  };
  checkpoint(report);
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [index, task] of tasks.entries()) {
      const offset = (index + repeat) % arms.length;
      for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) {
        const clientId = benchmarkClientId();
        const taskName = `Benchmark ${task.id} ${repeat} ${arm}`;
        const url = new URL(`/corpus/${task.id}`, baseUrl).href;
        const sample = { task: task.id, kind: task.kind, locale: task.locale, arm, repeat, success: false, falseCompletion: false };
        const previousId = process.env.EGO_BROWSER_AGENT_ID;
        let verifier;
        try {
          process.env.EGO_BROWSER_AGENT_ID = clientId;
          verifier = await EgoMcpSession.connect(pipe, { autoStartDesktop: false });
          await verifier.sdk.taskSpaces.useOrCreate(taskName);
          await verifier.sdk.browser.openOrReuseTab(url, { wait: true });
          if (!task.extract) assert.notDeepEqual(await verifier.sdk.page.evaluate(task.inspect), task.expected);
          Object.assign(sample, await codexTrial({ config, mcpEntry, pipe, work, arm, clientId, schemaPath,
            prompt: benchmarkPrompt(task, arm, url, taskName), checkpoint: trial => checkpoint({ ...report, current: { ...sample, ...trial } }) }));
          const actual = task.extract ? sample.final?.rows : await verifier.sdk.page.evaluate(task.inspect);
          let verified = true;
          try { assert.deepEqual(actual, task.expected); } catch { verified = false; }
          sample.falseCompletion = Boolean(sample.final?.completed && !verified);
          sample.success = Boolean(verified && sample.final?.completed && !sample.offScope && sample.exit?.code === 0
            && (["auto", "repair"].includes(arm) || sample.jevRequests === 0) && (arm !== "sdk" || sample.automationRuns.length === 0));
        } catch (error) { sample.error = diagnostic(error?.message || error); }
        finally {
          await verifier?.close();
          if (previousId === undefined) delete process.env.EGO_BROWSER_AGENT_ID;
          else process.env.EGO_BROWSER_AGENT_ID = previousId;
        }
        report.samples.push(sample);
        report.summaries = Object.fromEntries(arms.map(arm => [arm, summarizeCodexSamples(report.samples.filter(sample => sample.arm === arm))]));
        checkpoint(report);
        if (sample.startupMs === null && sample.exit?.code !== 0) {
          report.passed = false;
          report.stoppedReason = "Codex failed before starting a model turn; remaining samples were not attempted.";
          return report;
        }
      }
    }
  }
  report.passed = report.samples.every(sample => sample.success && !sample.falseCompletion) && report.samples.length === tasks.length * repeats * arms.length;
  report.acceptance = assessCodexBenchmark(report);
  checkpoint(report);
  return report;
}
