import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrokerCore, TaskSpaceService } from "@ego-compat/broker-core";
import { ManagedEdgeBackend } from "@ego-compat/managed-edge";
import { createEgoRuntime, PipeRuntimeTransport } from "@ego-compat/runtime-adapter";

import { BrokerPipeServer } from "../../broker/src/server.ts";
import { installPublicEgoSdk } from "./sdk.ts";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

test(
  "public ego-browser SDK fills and submits a real page through the Windows runtime",
  { timeout: 45_000 },
  async (t) => {
    try {
      await readFile(edgePath);
    } catch {
      t.skip("Microsoft Edge is not installed");
      return;
    }

    const profilePath = await mkdtemp(join(tmpdir(), "ego-public-sdk-test-"));
    const fixture = await startFixtureServer();
    const managed = new ManagedEdgeBackend({ executablePath: edgePath, profilePath, headless: true });
    const broker = new BrokerCore(new TaskSpaceService({ backend: "managed" }), managed);
    const server = new BrokerPipeServer(broker);
    const pipeName = `\\\\.\\pipe\\ego-sdk-test-${process.pid}-${Date.now()}`;
    await server.listen(pipeName);
    const transport = await PipeRuntimeTransport.connect(pipeName);
    const runtime = createEgoRuntime(transport, { clientId: "public-sdk-agent" });

    const previousEgo = (globalThis as Record<string, unknown>).ego;
    try {
      await installPublicEgoSdk(runtime as unknown as Record<string, unknown>);
      const egoController = (globalThis as unknown as {
        ego: {
          controller: {
            getAllTabs(): Promise<Array<{ id: string }>>;
            getAIPageContent(tab: { id: string }): Promise<{ title: string } | null>;
            saveTextToCollections(text: string, sourceUrl?: string): Promise<boolean>;
            listCollections(query?: string): Promise<Array<{ text: string }>>;
            onActiveTabChanged?: (tab: unknown) => void;
            onTextSelectionChanged?: (selection: unknown) => void;
          };
        };
      }).ego.controller;
      const sdk = globalThis as unknown as {
        taskSpaces: { "new": (name: string) => Promise<unknown> };
        browser: { openOrReuseTab(url: string, options: object): Promise<unknown> };
        page: {
          snapshot(): Promise<string>;
          getByLabel(name: string): { fill(value: string): Promise<void> };
          getByRole(role: string, options: object): { click(): Promise<void> };
          locator(selector: string): {
            textContent(): Promise<string>;
            fill(value: string): Promise<void>;
            click(): Promise<void>;
            setInputFiles(path: string): Promise<void>;
          };
          screenshot(options?: object): Promise<string>;
          waitForEvent(name: "download", options?: object): Promise<{
            suggestedFilename(): string;
            path(): Promise<string>;
          }>;
          info(): Promise<Record<string, any>>;
          drainEvents(): Promise<Array<{ method?: string }>>;
        };
        cdp(
          method: string,
          params?: object,
          sessionId?: string,
        ): Promise<Record<string, any>>;
      };

      await sdk.taskSpaces.new("sdk-poc");
      await sdk.browser.openOrReuseTab(fixture.url, { wait: true });
      const controllerTabs = await egoController.getAllTabs();
      const controllerPage = await egoController.getAIPageContent(controllerTabs.at(-1)!);
      const activeListener = () => {};
      const selectionListener = () => {};
      egoController.onActiveTabChanged = activeListener;
      egoController.onTextSelectionChanged = selectionListener;
      assert.ok(controllerTabs.length > 0);
      assert.match(controllerPage?.title ?? "", /Ego Windows compatibility fixture/);
      assert.equal(runtime.onActiveTabChanged, activeListener);
      assert.equal(runtime.onTextSelectionChanged, selectionListener);
      assert.equal(
        await egoController.saveTextToCollections("SDK selected text", fixture.url),
        true,
      );
      assert.equal((await egoController.listCollections("SDK"))[0]?.text, "SDK selected text");
      const snapshot = await sdk.page.snapshot();
      assert.match(snapshot, /textbox \[ref=@\d+\]/);
      assert.match(snapshot, /button \[ref=@\d+\]/);

      await sdk.page.getByLabel("Task name").fill("Public SDK");
      await sdk.page.getByRole("button", { name: "Create task" }).click();
      assert.equal(await sdk.page.locator("#result").textContent(), "Created: Public SDK");

      const textboxRef = /textbox \[ref=@(\d+)\]/.exec(snapshot)?.[1];
      assert.ok(textboxRef);
      const freshSnapshot = await sdk.page.snapshot();
      const buttonRef = /button \[ref=@(\d+)\]/.exec(freshSnapshot)?.[1];
      assert.ok(buttonRef);
      await sdk.page.locator(`@${textboxRef}`).fill("Ref path");
      await sdk.page.locator(`@${buttonRef}`).click();
      assert.equal(await sdk.page.locator("#result").textContent(), "Created: Ref path");

      const screenshotPath = await sdk.page.screenshot();
      assert.deepEqual(
        [...(await readFile(screenshotPath)).subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );

      const uploadPath = join(profilePath, "upload-fixture.txt");
      await writeFile(uploadPath, "upload fixture", "utf8");
      await sdk.page.locator("#upload").setInputFiles(uploadPath);
      assert.equal(
        await sdk.page.locator("#upload-result").textContent(),
        "upload-fixture.txt",
      );

      const downloadPromise = sdk.page.waitForEvent("download");
      await sdk.page.locator("#download").click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "ego-fixture.txt");
      assert.equal(await readFile(await download.path(), "utf8"), "ego download fixture");

      await sdk.cdp("Page.enable");
      await sdk.cdp("Runtime.evaluate", {
        expression: 'setTimeout(() => alert("Ego dialog"), 0)',
      });
      await waitForSdkEvent(sdk.page, "Page.javascriptDialogOpening");
      const info = await waitForDialog(sdk.page);
      assert.equal(info.dialog?.message, "Ego dialog");
      await sdk.cdp("Page.handleJavaScriptDialog", { accept: true });

      const targetsBeforePopup = new Set<string>(
        (((await sdk.cdp("Target.getTargets")).targetInfos ?? []) as Array<{
          targetId: string;
        }>).map(
          (target: { targetId: string }) => target.targetId,
        ),
      );
      await sdk.page.locator("#popup").click();
      const popupTargetId = await waitForNewPageTarget(sdk.cdp, targetsBeforePopup);
      const popupAttach = await sdk.cdp("Target.attachToTarget", {
        targetId: popupTargetId,
        flatten: true,
      });
      const popupRuntime = await sdk.cdp(
        "Runtime.evaluate",
        { expression: "6 * 7", returnByValue: true },
        popupAttach.sessionId,
      );
      assert.equal(popupRuntime.result.value, 42);

      const cliOutput = await runCli(pipeName, fixture.url);
      assert.match(cliOutput, /Task fixture/);
      assert.match(cliOutput, /textbox \[ref=@\d+\]/);
    } finally {
      if (previousEgo === undefined) delete (globalThis as Record<string, unknown>).ego;
      else (globalThis as Record<string, unknown>).ego = previousEgo;
      await transport.close();
      await server.close();
      await fixture.close();
      await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);

async function waitForDialog(page: { info(): Promise<Record<string, any>> }) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const info = await page.info();
    if (info.dialog) return info;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for JavaScript dialog");
}

async function waitForSdkEvent(
  page: { drainEvents(): Promise<Array<{ method?: string }>> },
  method: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await page.drainEvents()).some((event) => event.method === method)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for SDK event: ${method}`);
}

async function waitForNewPageTarget(
  cdp: (method: string, params?: object) => Promise<Record<string, any>>,
  previousTargets: Set<string>,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const targets = (await cdp("Target.getTargets")).targetInfos ?? [];
    const match = targets.find(
      (target: { targetId?: string; type?: string }) =>
        target.type === "page" && target.targetId && !previousTargets.has(target.targetId),
    );
    if (match?.targetId) return match.targetId;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a new page target");
}

function runCli(pipeName: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/ego-browser/src/main.ts"], {
      cwd: new URL("../../..", import.meta.url),
      env: {
        ...process.env,
        EGO_COMPAT_PIPE: pipeName,
        EGO_BROWSER_AGENT_ID: "cli-smoke-agent",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI exited ${code}: ${stderr}`));
    });
    child.stdin.end(`
      await taskSpaces.new("CLI fixture")
      await browser.openOrReuseTab(${JSON.stringify(url)}, { wait: true })
      console.log(await page.snapshot())
    `);
  });
}

async function startFixtureServer(): Promise<{ url: string; close(): Promise<void> }> {
  const html = await readFile(
    new URL("../../../fixtures/browser/form.html", import.meta.url),
    "utf8",
  );
  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="ego-fixture.txt"',
      });
      response.end("ego download fixture");
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Ego popup</title><h1>Popup content</h1>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/form.html`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
