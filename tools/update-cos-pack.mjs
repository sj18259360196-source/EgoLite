import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DesktopRpcClient } from "../apps/desktop-mcp-server/src/client.ts";
import { buildCosCandidate } from "../integrations/cos/build-candidate.mjs";

const { values } = parseArgs({ options: {
  pack: { type: "string" }, rollback: { type: "boolean" }, endpoint: { type: "string" },
  ref: { type: "string" }, "prepare-only": { type: "boolean" },
} });
if ([values.pack, values.ref, values.rollback].filter(Boolean).length !== 1) throw new Error("Choose --ref <tag or commit>, --pack <directory>, or --rollback");
if (values["prepare-only"] && !values.ref) throw new Error("--prepare-only requires --ref");
const candidate = values.ref ? await buildCosCandidate(values.ref) : null;
if (values["prepare-only"]) {
  console.log(JSON.stringify(candidate, null, 2));
  process.exit(0);
}
const path = values.endpoint || process.env.EGO_COS_MAINTENANCE_ENDPOINT
  || join(process.env.LOCALAPPDATA, "EgoCompat/workspace-packs/cos/maintenance-endpoint.json");
const endpoint = JSON.parse(await readFile(path, "utf8"));
const client = new DesktopRpcClient(endpoint.pipe);
try {
  const result = await client.request(values.rollback ? "package.rollback" : "package.update", {
    __cosMaintenanceToken: endpoint.token,
    ...(!values.rollback ? { directory: candidate?.directory || resolve(values.pack) } : {}),
  });
  const { id, version, state, enabled, directory, backupDirectory } = result;
  console.log(JSON.stringify({ id, version, state, enabled, directory, backupDirectory }, null, 2));
} finally { client.close(); }
