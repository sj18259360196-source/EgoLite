import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { ensureDesktopHost } from "./desktop-host.ts";

test("desktop host bootstrap starts one host and waits for both pipes", async () => {
  const root = join(process.cwd(), ".tmp", "codex");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "desktop-host-test-"));
  const lockPath = join(directory, "wake.lock");
  const probes = new Map<string, number>();
  const ready = new Set<string>();
  let spawns = 0;
  try {
    const probe = async (pipe: string) => {
      probes.set(pipe, (probes.get(pipe) || 0) + 1);
      return ready.has(pipe);
    };
    await ensureDesktopHost({
      pipeName: "broker-pipe",
      automationPipeName: "automation-pipe",
      lockPath,
      timeoutMs: 1_000,
      probe,
      spawnHost: async () => {
        spawns += 1;
        ready.add("broker-pipe");
        ready.add("automation-pipe");
      },
    });
    assert.equal(spawns, 1);
    assert.ok((probes.get("broker-pipe") || 0) >= 2);
    assert.ok((probes.get("automation-pipe") || 0) >= 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop host bootstrap does not start a second host when both pipes are ready", async () => {
  const root = join(process.cwd(), ".tmp", "codex");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "desktop-host-test-"));
  try {
    let spawns = 0;
    await ensureDesktopHost({
      pipeName: "broker-pipe",
      automationPipeName: "automation-pipe",
      lockPath: join(directory, "wake.lock"),
      probe: async () => true,
      spawnHost: async () => { spawns += 1; },
    });
    assert.equal(spawns, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
