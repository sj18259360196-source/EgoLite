import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readCosPack } from "./cos-archive.mjs";

export async function migrateMissingLegacyCos(options, config) {
  if (!options.builtin || !config.directory || config.source && config.source !== "legacy") return config;
  try { await stat(config.directory); return config; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifest = await readCosPack(options.defaultDirectory);
  if (config.packVersion !== manifest.packVersion && !options.builtinReplaces?.includes(config.packVersion)) {
    throw new Error("旧 CoS 程序已丢失，内置版本与原版不同，未自动切换；数据保留");
  }
  const original = await readFile(options.registryPath, "utf8");
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(config)) throw new Error("CoS 登记已变化，请重启后重试");
  const backups = join(dirname(options.registryPath), "migration-backups");
  await mkdir(backups, { recursive: true });
  const backup = join(backups, `legacy-${randomUUID()}.json`);
  await writeFile(backup, original, { flag: "wx" });
  const migrated = { ...config, directory: options.defaultDirectory, source: "builtin",
    installRoot: options.installRoot, migration: { from: config.directory, backup, at: new Date().toISOString() } };
  const temporary = options.registryPath + ".migration.tmp";
  await writeFile(temporary, JSON.stringify(migrated, null, 2) + "\n");
  await rename(temporary, options.registryPath);
  return migrated;
}
