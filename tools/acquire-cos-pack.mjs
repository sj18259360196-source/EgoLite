import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildCosCandidate } from "../integrations/cos/build-candidate.mjs";

const { values } = parseArgs({ options: { "install-root": { type: "string" }, "work-root": { type: "string" } } });
if (!values["install-root"] || !values["work-root"]) throw new Error("CoS installation and work directories are required");
const upstream = JSON.parse(await readFile(new URL("../integrations/cos/upstream.json", import.meta.url), "utf8"));
const controller = new AbortController();
const cancel = () => controller.abort(new Error("CoS installation cancelled"));
process.once("disconnect", cancel);
process.on("message", message => { if (message?.type === "cancel") cancel(); });
const send = message => { if (process.connected) process.send(message); };
try {
  const result = await buildCosCandidate(upstream.commit, {
    installRoot: resolve(values["install-root"]), workRoot: resolve(values["work-root"]),
    sourceMode: "archive", signal: controller.signal, onProgress: progress => send({ type: "progress", progress }),
  });
  send({ type: "result", result });
} catch (error) {
  console.error(error.stack);
  send({ type: "failure", error: error.message });
  process.exitCode = 1;
} finally {
  process.removeListener("disconnect", cancel);
  process.disconnect?.();
}
