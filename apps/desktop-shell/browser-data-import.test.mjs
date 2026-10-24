import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { discoverBrowserExtensions, discoverBrowserProfiles, importBrowserProfile } from "./browser-data-import.mjs";

test("discovers Chromium profiles and imports bookmarks plus recent history", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-import-test-"));
  try {
    const userData = join(root, "Google", "Chrome", "User Data");
    const profilePath = join(userData, "Default");
    mkdirSync(profilePath, { recursive: true });
    writeFileSync(join(userData, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Person 1" } } },
    }));
    writeFileSync(join(profilePath, "Bookmarks"), JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: [
            { type: "url", name: "OpenAI", url: "https://openai.com", date_added: "13380163200000000" },
            { type: "url", name: "Internal", url: "chrome://settings" },
          ],
        },
      },
    }));
    const history = new DatabaseSync(join(profilePath, "History"));
    history.exec("CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)");
    history.prepare("INSERT INTO urls VALUES (?, ?, ?, ?)").run(
      "https://example.com/recent",
      "Recent page",
      4,
      13_380_163_200_000_000,
    );
    history.close();

    const braveUserData = join(root, "BraveSoftware", "Brave-Browser", "User Data");
    const braveProfile = join(braveUserData, "Profile 1");
    mkdirSync(braveProfile, { recursive: true });
    writeFileSync(join(braveUserData, "Local State"), JSON.stringify({
      profile: { info_cache: { "Profile 1": { name: "Brave profile" } } },
    }));
    writeFileSync(join(braveProfile, "Bookmarks"), JSON.stringify({
      roots: { bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [{ type: "url", name: "Brave Search", url: "https://search.brave.com" }] } },
    }));

    const profiles = discoverBrowserProfiles(root);
    assert.equal(profiles.length, 2);
    const chrome = profiles.find((profile) => profile.browserId === "chrome");
    const brave = profiles.find((profile) => profile.browserId === "brave");
    assert.equal(chrome?.profileName, "Person 1");
    assert.equal(chrome?.bookmarks, true);
    assert.equal(chrome?.history, true);
    assert.equal(brave?.profileName, "Brave profile");
    assert.equal(brave?.bookmarks, true);

    const imported = importBrowserProfile(chrome, { historyLimit: 10 });
    assert.deepEqual(imported.errors, []);
    assert.equal(imported.entries.length, 1);
    assert.equal(imported.historyEntries.length, 1);
    assert.equal(imported.entries.some((entry) => entry.sourceUrl === "https://openai.com"), true);
    assert.equal(imported.entries[0]?.pageTitle, "OpenAI");
    assert.equal(imported.entries[0]?.group, "Bookmarks bar");
    assert.equal(imported.historyEntries.some((entry) => entry.title === "Recent page"), true);
    assert.equal(imported.historyEntries[0]?.visitCount, 4);
    assert.equal(imported.entries.some((entry) => entry.sourceUrl?.startsWith("chrome://")), false);
    const braveImported = importBrowserProfile(brave, { history: false });
    assert.equal(braveImported.entries[0]?.sourceUrl, "https://search.brave.com");
    assert.deepEqual(braveImported.historyEntries, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers installed extensions without reading browser profile state", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-browser-extension-discovery-test-"));
  try {
    const profilePath = join(root, "Microsoft", "Edge", "User Data", "Default");
    const extensionPath = join(profilePath, "Extensions", "abcdefghijklmnopabcdefghijklmnop", "1.2.3");
    mkdirSync(extensionPath, { recursive: true });
    writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      name: "Fixture Add-on",
      version: "1.2.3",
      description: "Only copy this extension when selected",
      permissions: ["storage"],
      host_permissions: ["https://example.com/*"],
    }));
    const profile = { id: "edge:Default", browserId: "edge", browserName: "Microsoft Edge", profileId: "Default", profileName: "Default", path: profilePath };
    const extensions = discoverBrowserExtensions(profile);
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0]?.name, "Fixture Add-on");
    assert.deepEqual(extensions[0]?.permissions, ["storage", "https://example.com/*"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
