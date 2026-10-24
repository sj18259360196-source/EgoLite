import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EgoProtocolError } from "@ego-compat/protocol";
import { TaskSpaceService } from "@ego-compat/broker-core";

import { SqliteTaskSpaceStore } from "./sqlite-task-store.ts";

test("SQLite restores tasks as user inactive with a fenced epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ego-state-test-"));
  const path = join(directory, "state.db");
  const firstStore = new SqliteTaskSpaceStore(path);
  const first = new TaskSpaceService({ backend: "companion", store: firstStore });
  const created = first.create("Persisted task", "agent-a");
  firstStore.close();

  const secondStore = new SqliteTaskSpaceStore(path);
  try {
    const second = new TaskSpaceService({ backend: "companion", store: secondStore });
    second.recoverAfterRestart();
    const recovered = second.list()[0]!;
    assert.equal(recovered.taskId, created.taskId);
    assert.equal(recovered.ownership, "user");
    assert.throws(
      () => second.select(recovered.id, "agent-b"),
      (error: unknown) =>
        error instanceof EgoProtocolError && error.error_code === "EGO_TASK_SPACE_INACTIVE",
    );
    const claimed = second.claim(recovered.id, "agent-b");
    assert.equal(claimed.ownership, "agent");
    assert.ok(claimed.leaseEpoch > created.leaseEpoch);
    const next = second.create("Next task", "agent-b");
    assert.equal(next.id, created.id + 1);
  } finally {
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite persists collection items across broker restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ego-collection-test-"));
  const path = join(directory, "state.db");
  const firstStore = new SqliteTaskSpaceStore(path);
  firstStore.saveCollections([{
    id: "collection-1",
    text: "Selected research text",
    sourceUrl: "https://example.test/article",
    pageTitle: "Research article",
    createdAt: "2026-08-13T00:00:00.000Z",
  }]);
  firstStore.close();

  const secondStore = new SqliteTaskSpaceStore(path);
  try {
    assert.deepEqual(secondStore.loadCollections(), [{
      id: "collection-1",
      text: "Selected research text",
      sourceUrl: "https://example.test/article",
      pageTitle: "Research article",
      createdAt: "2026-08-13T00:00:00.000Z",
    }]);
  } finally {
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
