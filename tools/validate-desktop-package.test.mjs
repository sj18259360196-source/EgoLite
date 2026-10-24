import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { validateDesktopImports } from "./validate-desktop-package.mjs";

test("desktop audit rejects repository dependency fallback and accepts builtins", async t => {
  const root = resolve(".tmp/codex/cos7-package-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "imports-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "main.mjs"), "import './archive.mjs';");
  await writeFile(join(directory, "archive.mjs"), "import yauzl from 'yauzl'; console.log(yauzl);");
  await assert.rejects(validateDesktopImports(directory), /unbundled package imports: yauzl/);
  await writeFile(join(directory, "archive.mjs"), "import fs from 'node:fs'; import {app} from 'electron'; console.log(fs,app);");
  await validateDesktopImports(directory);
});
