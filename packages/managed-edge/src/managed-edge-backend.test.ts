import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EgoProtocolError, type TaskSpaceRecord } from "@ego-compat/protocol";

import { ManagedEdgeBackend } from "./managed-edge-backend.ts";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

test(
  "managed Edge creates isolated task targets, evaluates, and snapshots a real page",
  { timeout: 30_000 },
  async (t) => {
    try {
      await readFile(edgePath);
    } catch {
      t.skip("Microsoft Edge is not installed");
      return;
    }

    const profilePath = await mkdtemp(join(tmpdir(), "ego-managed-edge-test-"));
    const fixture = await startFixtureServer();
    const backend = new ManagedEdgeBackend({
      executablePath: edgePath,
      profilePath,
      headless: true,
    });

    try {
      await backend.createSpace(space("task-a", 1));
      await backend.createSpace(space("task-b", 2));
      const tabA = await backend.createTab("task-a", fixture.url);
      const tabB = await backend.createTab("task-b", `${fixture.url}?second=1`);

      const attachResponse = JSON.parse(
        await backend.sendCdp(
          "task-a",
          JSON.stringify({
            id: 1,
            method: "Target.attachToTarget",
            params: { targetId: tabA.targetId, flatten: true },
          }),
        ),
      );
      const sessionId = attachResponse.result.sessionId as string;
      await waitForExpression(
        backend,
        "task-a",
        sessionId,
        'document.readyState === "complete" && Boolean(document.querySelector("#task-form"))',
      );
      const selectionEvent = new Promise<string>((resolve) => {
        backend.onTextSelectionChanged((_taskId, selection) => resolve(selection.text));
      });
      await backend.sendCdp(
        "task-a",
        JSON.stringify({
          id: 29,
          method: "Runtime.evaluate",
          sessionId,
          params: {
            expression: `(() => {
              const range = document.createRange();
              range.selectNodeContents(document.querySelector("h1"));
              const selection = getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            })()`,
          },
        }),
      );
      assert.equal(await selectionEvent, "Task fixture");
      await backend.sendCdp(
        "task-a",
        JSON.stringify({ id: 30, method: "Page.enable", sessionId, params: {} }),
      );
      await backend.sendCdp(
        "task-a",
        JSON.stringify({
          id: 2,
          method: "Runtime.evaluate",
          sessionId,
          params: {
            expression:
              'document.querySelector("#task-name").value="Windows"; document.querySelector("#task-form").requestSubmit();',
            awaitPromise: true,
          },
        }),
      );

      const result = JSON.parse(
        await backend.sendCdp(
          "task-a",
          JSON.stringify({
            id: 3,
            method: "Runtime.evaluate",
            sessionId,
            params: {
              expression: 'document.querySelector("#result").textContent',
              returnByValue: true,
            },
          }),
        ),
      );
      assert.equal(result.result.result.value, "Created: Windows");

      await backend.sendCdp(
        "task-a",
        JSON.stringify({
          id: 31,
          method: "Runtime.evaluate",
          sessionId,
          params: {
            expression: `document.body.append(Object.assign(document.createElement("iframe"), { src: ${JSON.stringify(fixture.frameUrl)} }))`,
          },
        }),
      );
      const frameTargetId = await waitForOwnedTarget(backend, "task-a", "/frame");
      const frameAttach = JSON.parse(
        await backend.sendCdp(
          "task-a",
          JSON.stringify({
            id: 32,
            method: "Target.attachToTarget",
            params: { targetId: frameTargetId, flatten: true },
          }),
        ),
      );
      await waitForExpression(
        backend,
        "task-a",
        frameAttach.result.sessionId,
        'document.title === "Cross-site frame"',
      );
      await assert.rejects(
        () =>
          backend.sendCdp(
            "task-b",
            JSON.stringify({
              id: 33,
              method: "Target.attachToTarget",
              params: { targetId: frameTargetId, flatten: true },
            }),
          ),
        (error: unknown) =>
          error instanceof EgoProtocolError &&
          error.error_code === "EGO_CDP_CHANNEL_UNAVAILABLE",
      );

      const snapshot = await backend.snapshot("task-a", {
        includeActionMarks: true,
        includeStableLocator: true,
      });
      assert.match(snapshot.content, /Task fixture/);
      assert.ok(snapshot.refs.some((ref) => ref.role.toLowerCase() === "textbox"));
      assert.ok(snapshot.refs.some((ref) => ref.role.toLowerCase() === "button"));
      assert.doesNotMatch(snapshot.content, /Hidden action/);
      assert.match(snapshot.content, /Below fold/);

      const viewportSnapshot = await backend.snapshot("task-a", {
        scope: "only_within_viewport",
        includeActionMarks: true,
      });
      assert.doesNotMatch(viewportSnapshot.content, /Below fold/);

      const truncated = await backend.snapshot("task-a", {
        includeActionMarks: true,
        maxResultLength: 80,
      });
      for (const ref of truncated.refs) {
        assert.match(truncated.content, new RegExp(`\\[ref=@${ref.backendNodeId}\\]`));
      }

      await assert.rejects(
        () =>
          backend.sendCdp(
            "task-a",
            JSON.stringify({
              id: 4,
              method: "Target.attachToTarget",
              params: { targetId: tabB.targetId, flatten: true },
            }),
          ),
        (error: unknown) =>
          error instanceof EgoProtocolError &&
          error.error_code === "EGO_CDP_CHANNEL_UNAVAILABLE",
      );

      const visibleTargets = JSON.parse(
        await backend.sendCdp(
          "task-a",
          JSON.stringify({ id: 5, method: "Target.getTargets", params: {} }),
        ),
      );
      const visibleTargetIds = visibleTargets.result.targetInfos.map(
        (target: { targetId: string }) => target.targetId,
      );
      assert.ok(visibleTargetIds.includes(tabA.targetId));
      assert.ok(visibleTargetIds.includes(frameTargetId));
      assert.ok(!visibleTargetIds.includes(tabB.targetId));
    } finally {
      await backend.dispose();
      await fixture.close();
      await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);

async function waitForExpression(
  backend: ManagedEdgeBackend,
  taskId: string,
  sessionId: string,
  expression: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = JSON.parse(
      await backend.sendCdp(
        taskId,
        JSON.stringify({
          id: Date.now(),
          method: "Runtime.evaluate",
          sessionId,
          params: { expression, returnByValue: true },
        }),
      ),
    );
    if (response.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

function space(taskId: string, id: number): TaskSpaceRecord {
  const now = new Date().toISOString();
  return {
    taskId,
    id,
    name: taskId,
    createdBy: "test",
    ownership: "agent",
    lifecycle: "active",
    backend: "managed",
    generation: 1,
    leaseEpoch: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitForOwnedTarget(
  backend: ManagedEdgeBackend,
  taskId: string,
  urlPart: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = JSON.parse(
      await backend.sendCdp(
        taskId,
        JSON.stringify({ id: Date.now(), method: "Target.getTargets", params: {} }),
      ),
    );
    const target = response.result.targetInfos.find(
      (candidate: { targetId: string; url: string }) => candidate.url.includes(urlPart),
    );
    if (target) return target.targetId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for owned target: ${urlPart}`);
}

async function startFixtureServer(): Promise<{
  url: string;
  frameUrl: string;
  close(): Promise<void>;
}> {
  const html = await readFile(
    new URL("../../../fixtures/browser/form.html", import.meta.url),
    "utf8",
  );
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/frame"
        ? "<!doctype html><title>Cross-site frame</title><h1>Frame content</h1>"
        : html,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/form.html`,
    frameUrl: `http://localhost:${address.port}/frame`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
