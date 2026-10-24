import { app, safeStorage } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AutomationSettings } from "../apps/desktop-shell/automation-decision-service.mjs";

const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
if (!process.env.EGO_SETTINGS_HELPER_DATA) throw new Error("An isolated helper data directory is required");
app.setPath("userData", process.env.EGO_SETTINGS_HELPER_DATA);
app.whenReady().then(() => {
  const settings = new AutomationSettings(join(process.env.LOCALAPPDATA, "EgoCompat", "automation-settings.json"), safeStorage);
  const before = settings.public("default");
  if (key && !before.configured) settings.save("default", { key, memoryOnly: false });
  assert.ok(settings.key("default").length >= 8);
  console.log(JSON.stringify({ profile: "default", encryptedKeyReadable: true, settings: settings.public("default") }));
  app.quit();
}).catch(() => {
  console.error("Installed automation credential configuration failed; no secret was logged.");
  app.exit(1);
});
