import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { automationCorpus } from "./automation-corpus.mjs";
import { EgoMcpSession } from "../apps/ego-mcp-server/src/ego-session.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function probeAutomationSdk(pipe, baseUrl, { live = false, mcpEntry } = {}) {
  const root = resolve(import.meta.dirname, "..");
  const cases = automationCorpus().filter(task => ["en-form-1", "zh-form-1", "en-pagination-1"].includes(task.id));
  const samples = [];
  const clientId = `sdk-smoke-${randomUUID()}`;
  for (const task of cases) {
    for (const mode of task.extract ? ["direct"] : live ? ["direct", "auto"] : ["direct"]) {
      const input = task.extract || { goal: task.goal, values: task.values, success: task.success,
        steps: mode === "direct" ? task.steps : [], mode };
      const source = `
        await taskSpaces.useOrCreate("SDK automation smoke");
        await browser.openOrReuseTab(${JSON.stringify(new URL(`/corpus/${task.id}`, baseUrl).href)}, {wait:true});
        await page.reload();
        const result = await automation.${task.extract ? "extract" : "run"}(${JSON.stringify(input)});
        console.log(JSON.stringify({result,actual:${task.extract ? "result.rows" : `await page.evaluate(${JSON.stringify(task.inspect)})`}}));
      `;
      const env = { ...process.env, EGO_COMPAT_PIPE: pipe, EGO_AGENT_INTEGRATION_DISABLED: "1", EGO_BROWSER_AGENT_ID: clientId };
      for (const key of ["TYPESAFE_API_KEY", "CODEX_THREAD_ID", "CODEX_SESSION_ID"]) delete env[key];
      const child = spawn(process.execPath, ["apps/ego-browser/src/main.ts"], {
        cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
      const timeout = setTimeout(() => child.kill(), 60000);
      child.stdin.end(source);
      try {
        assert.equal(await exit, 0, stderr);
        const result = JSON.parse(stdout.trim());
        assert.equal(result.result.status, "done", JSON.stringify(result.result));
        assert.equal(result.result.verified, true);
        assert.deepEqual(result.actual, task.expected);
        if (mode === "auto") assert.ok(result.result.metrics.requestAttempts > 0);
        else assert.equal(result.result.metrics.requestAttempts, 0);
        samples.push({ task: task.id, mode, ...result });
      } finally { clearTimeout(timeout); }
    }
  }
  if (mcpEntry) {
    const previous = process.env.EGO_BROWSER_AGENT_ID;
    process.env.EGO_BROWSER_AGENT_ID = clientId;
    let reset;
    try {
      reset = await EgoMcpSession.connect(pipe, { autoStartDesktop: false });
      await reset.sdk.taskSpaces.useOrCreate("SDK automation smoke");
      await reset.sdk.page.goto(new URL("/corpus/en-pagination-1", baseUrl).href);
    } finally {
      await reset?.close();
      if (previous === undefined) delete process.env.EGO_BROWSER_AGENT_ID;
      else process.env.EGO_BROWSER_AGENT_ID = previous;
    }
    const env = { ...process.env, EGO_COMPAT_PIPE: pipe, EGO_BROWSER_AGENT_ID: clientId, EGO_DESKTOP_AUTOSTART: "0" };
    delete env.TYPESAFE_API_KEY;
    const client = new Client({ name: "sdk-mcp-handoff-smoke", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry], cwd: root, env, stderr: "pipe" }));
      const task = automationCorpus().find(task => task.id === "en-pagination-1");
      // No ego_task_use on this new transport: selection must come from the explicit task argument.
      const response = await client.callTool({ name: "ego_extract", arguments: { ...task.extract, task: "SDK automation smoke" } });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const data = JSON.parse(response.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
      assert.equal(data.complete, true);
      assert.deepEqual(data.rows, task.expected);
      samples.push({ task: task.id, mode: "fresh-mcp-explicit-task", result: data });
    } finally { await client.close(); }
  }
  return { passed: true, samples };
}
