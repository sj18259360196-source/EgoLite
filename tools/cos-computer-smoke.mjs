import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import electron from "electron";

const root = resolve(import.meta.dirname, "..");
const source = resolve(process.argv[2], "source/src/main/computer");
const base = join(root, ".tmp/codex/cos-computer-audit");
await mkdir(base, { recursive: true });
const work = await mkdtemp(join(base, "run-"));
let result = { passed: false };
try {
  await build({ stdin: { contents: `export {createWindowsComputerApi} from ${JSON.stringify(join(source, "windows-api.ts"))}; export {stopComputerHelper} from ${JSON.stringify(join(source, "index.ts"))};`, resolveDir: root },
    outfile: join(work, "computer.cjs"), bundle: true, platform: "node", target: "node24", format: "cjs", external: ["electron"] });
  const env = { ...process.env, EGO_COS_COMPUTER_TEST: work, TEMP: work, TMP: work,
    APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await promisify(execFile)(electron, [join(root, "tools/cos-computer-fixture.cjs")], {
      cwd: work, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    });
  } catch (error) { result.error = error.message; }
  result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
  if (!result.passed) process.exitCode = 1;
} catch (error) { result.error = error.stack; process.exitCode = 1; }
finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rmdir(base).catch(error => { if (error.code !== "ENOTEMPTY") throw error; });
  await writeFile(join(root, "docs/cos-workspace-pack/evidence/cos-computer-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
