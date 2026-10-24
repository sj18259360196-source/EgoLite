import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { BrokerCore, FakeBrowserBackend, TaskSpaceService } from "@ego-compat/broker-core";
import { PipeRuntimeTransport } from "@ego-compat/runtime-adapter";

import { BrokerPipeServer } from "../broker/src/server.ts";

const DESKTOP_CONTROL_TOKEN = "desktop-delete-regression-token-32-bytes";

test("trusted desktop force-closes an agent-owned space while control handoff is disabled", async () => {
  const harness = await createPipeHarness("single");
  const agent = await PipeRuntimeTransport.connect(harness.pipeName);
  harness.transports.push(agent);
  const desktopEvents = [];
  const agentEvents = [];
  harness.desktop.onEvent((method, params) => desktopEvents.push({ method, params }));
  agent.onEvent((method, params) => agentEvents.push({ method, params }));

  try {
    await registerAgent(agent, "codex-delete-single");
    const created = await agent.request("space.create", {
      clientId: "codex-delete-single",
      name: "Agent-owned deletion",
    });
    const oldEpoch = created.leaseEpoch;
    await createTabsWithPinnedFixture(harness.backend, agent, "codex-delete-single", created);

    assert.equal(created.ownership, "agent");
    assert.deepEqual(
      await harness.desktop.request("control.handoff.get", { clientId: harness.desktopClientId }),
      { enabled: false },
    );
    await assert.rejects(
      agent.request("space.forceClose", { clientId: "codex-delete-single", id: created.id }),
      (error) => error?.error_code === "EGO_OPERATION_FAILED",
    );
    assert.equal(harness.backend.tabs.get(created.taskId)?.length, 2);

    const closed = await harness.desktop.request("space.forceClose", {
      clientId: harness.desktopClientId,
      id: created.id,
    });

    assert.equal(closed.ownership, "user");
    assert.equal(closed.lifecycle, "closed");
    assert.ok(closed.leaseEpoch > oldEpoch);
    assert.equal(harness.backend.tabs.has(created.taskId), false);
    assert.deepEqual(harness.backend.closeCalls, [{ taskId: created.taskId, visualSync: true }]);
    await waitFor(() => desktopEvents.some((event) => isRemovedSpaceEvent(event, created.taskId)));
    await waitFor(() => agentEvents.some((event) => event.method === "lease.revoked"));
    const spaces = await harness.desktop.request("space.list", { clientId: harness.desktopClientId });
    assert.equal(spaces.taskSpaces.some((space) => space.id === created.id), false);
    const status = await harness.desktop.request("agent.status", {
      clientId: harness.desktopClientId,
      targetClientId: "codex-delete-single",
    });
    assert.equal(status.agent?.currentTaskId, undefined);
    await assert.rejects(
      agent.request("tab.create", {
        clientId: "codex-delete-single",
        taskSpaceId: created.id,
        leaseEpoch: oldEpoch,
        url: "https://stale-after-delete.example",
      }),
      (error) => error?.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
    );
  } finally {
    await harness.close();
  }
});

test("sequential desktop batch deletion removes every space and its pinned tabs", async () => {
  const harness = await createPipeHarness("batch");
  const desktopEvents = [];
  harness.desktop.onEvent((method, params) => desktopEvents.push({ method, params }));
  const fixtures = [];

  try {
    for (const suffix of ["a", "b"]) {
      const clientId = `codex-delete-batch-${suffix}`;
      const agent = await PipeRuntimeTransport.connect(harness.pipeName);
      harness.transports.push(agent);
      await registerAgent(agent, clientId);
      const created = await agent.request("space.create", {
        clientId,
        name: `Batch deletion ${suffix}`,
      });
      await createTabsWithPinnedFixture(harness.backend, agent, clientId, created);
      fixtures.push({ agent, clientId, created, oldEpoch: created.leaseEpoch });
    }

    for (const fixture of fixtures) {
      await harness.desktop.request("space.forceClose", {
        clientId: harness.desktopClientId,
        id: fixture.created.id,
      });
    }

    await waitFor(() => fixtures.every((fixture) => (
      desktopEvents.some((event) => isRemovedSpaceEvent(event, fixture.created.taskId))
    )));
    assert.deepEqual(
      harness.backend.closeCalls.map((call) => call.taskId),
      fixtures.map((fixture) => fixture.created.taskId),
    );
    assert.ok(harness.backend.closeCalls.every((call) => call.visualSync === true));
    assert.ok(fixtures.every((fixture) => !harness.backend.tabs.has(fixture.created.taskId)));
    const spaces = await harness.desktop.request("space.list", { clientId: harness.desktopClientId });
    assert.ok(fixtures.every((fixture) => !spaces.taskSpaces.some((space) => space.id === fixture.created.id)));

    for (const fixture of fixtures) {
      await assert.rejects(
        fixture.agent.request("tab.create", {
          clientId: fixture.clientId,
          taskSpaceId: fixture.created.id,
          leaseEpoch: fixture.oldEpoch,
          url: "https://stale-batch-delete.example",
        }),
        (error) => error?.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
      );
    }
  } finally {
    await harness.close();
  }
});

class DeleteTrackingBackend extends FakeBrowserBackend {
  closeCalls = [];

  async closeSpace(taskId, options = {}) {
    this.closeCalls.push({ taskId, visualSync: options.visualSync === true });
    await super.closeSpace(taskId, options);
  }
}

async function createPipeHarness(label) {
  const pipeName = `\\\\.\\pipe\\ego-delete-regression-${label}-${process.pid}-${randomUUID()}`;
  const desktopClientId = `desktop-delete-${label}-${randomUUID()}`;
  const backend = new DeleteTrackingBackend();
  const broker = new BrokerCore(new TaskSpaceService(), backend);
  await broker.setControlHandoffEnabled(false);
  const server = new BrokerPipeServer(
    broker,
    undefined,
    undefined,
    undefined,
    { desktopControlToken: DESKTOP_CONTROL_TOKEN },
  );
  await server.listen(pipeName);
  const desktop = await PipeRuntimeTransport.connect(pipeName);
  await desktop.request("agent.register", {
    clientId: desktopClientId,
    clientKind: "desktop-ui",
    displayName: "Delete regression desktop",
    controlToken: DESKTOP_CONTROL_TOKEN,
  });
  const transports = [desktop];
  return {
    pipeName,
    desktopClientId,
    backend,
    desktop,
    transports,
    async close() {
      await Promise.allSettled(transports.map((transport) => transport.close()));
      await server.close();
    },
  };
}

async function registerAgent(transport, clientId) {
  await transport.request("agent.register", {
    clientId,
    clientKind: "codex",
    displayName: clientId,
    version: "delete-regression",
  });
}

async function createTabsWithPinnedFixture(backend, transport, clientId, created) {
  await transport.request("tab.create", {
    clientId,
    taskSpaceId: created.id,
    leaseEpoch: created.leaseEpoch,
    url: "https://pinned-delete.example",
  });
  await transport.request("tab.create", {
    clientId,
    taskSpaceId: created.id,
    leaseEpoch: created.leaseEpoch,
    url: "https://regular-delete.example",
  });
  const tabs = backend.tabs.get(created.taskId);
  assert.equal(tabs?.length, 2);
  tabs[0].pinned = true;
  assert.equal(tabs[0].pinned, true);
}

function isRemovedSpaceEvent(event, taskId) {
  return event.method === "space.changed"
    && event.params?.removed === true
    && event.params?.space?.taskId === taskId
    && event.params.space.lifecycle === "closed";
}

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for delete regression event");
}
