#!/usr/bin/env node

// Adapted from eze-is/web-access 2.5.4 under the MIT license.
// Match a query or URL against this skill's domain notes and print their bodies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patternsDirectory = path.join(skillRoot, "references", "site-patterns");
const query = (process.argv[2] || "").trim();
const queryHostnames = extractHostnames(query);

if (!query || !fs.existsSync(patternsDirectory)) process.exit(0);

for (const entry of fs.readdirSync(patternsDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

  const domain = entry.name.replace(/\.md$/, "");
  const source = fs.readFileSync(path.join(patternsDirectory, entry.name), "utf8");
  const aliasesLine = source.split(/\r?\n/).find((line) => line.startsWith("aliases:")) || "";
  const aliases = aliasesLine
    .replace(/^aliases:\s*/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedDomain = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  const hostnameMatches = queryHostnames.some(
    (hostname) => hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`),
  );
  const textMatches = queryHostnames.length === 0 && [domain, ...aliases].some(
    (value) => query.toLowerCase().includes(value.toLowerCase()),
  );
  if (!hostnameMatches && !textMatches) continue;

  const fences = [...source.matchAll(/^---\s*$/gm)];
  const body = fences.length >= 2
    ? source.slice(fences[1].index + fences[1][0].length).replace(/^\r?\n/, "")
    : source;
  process.stdout.write(`--- site experience: ${domain} ---\n`);
  process.stdout.write(`${body.trimEnd()}\n\n`);
}

function extractHostnames(value) {
  const candidates = value.match(
    /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:[/?#][^\s]*)?/gi,
  ) || [];
  const hostnames = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
      hostnames.push(url.hostname.toLowerCase().replace(/\.$/, ""));
    } catch {
      // Ignore malformed URL-like text and leave it available for alias matching.
    }
  }
  return hostnames;
}
