import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "..");
function agentWorkspace() {
  if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
  }
  const bundledSkill = resolve(SRC_DIR, "ego-browser");
  if (existsSync(bundledSkill)) {
    return bundledSkill;
  }
  return resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
}
function resolvePath(path) {
  if (path.startsWith("~")) {
    return resolve(process.env.HOME || process.env.USERPROFILE || ".", path.slice(1));
  }
  return resolve(path);
}
function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === void 0) {
      process.env[key] = value;
    }
  }
}
function loadEnv() {
  loadEnvFile(resolve(REPO_ROOT, ".env"));
  loadEnvFile(resolve(agentWorkspace(), ".env"));
}
export {
  REPO_ROOT,
  SRC_DIR,
  agentWorkspace,
  loadEnv,
  loadEnvFile,
  resolvePath
};
