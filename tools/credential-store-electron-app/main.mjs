import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createCredentialCipher, CredentialStore } from "../../apps/desktop-shell/credential-store.mjs";

const phase = process.env.EGO_CREDENTIAL_SMOKE_PHASE;
const work = process.env.EGO_CREDENTIAL_SMOKE_ROOT;
if (!phase || !work) throw new Error("Credential smoke phase is missing");
app.setPath("userData", join(work, "electron-user-data"));

void app.whenReady().then(runPhase).catch(writeFailure);

function runPhase() {
  try {
    const storePath = join(work, "credentials.json");
    const store = new CredentialStore(storePath, createCredentialCipher(safeStorage));
    let result;

    if (phase === "write") {
      store.save({ profileId: "default", origin: "https://login.example.test/sign-in", username: "alice", password: "alice-password" });
      store.save({ profileId: "default", origin: "https://login.example.test/sign-in", username: "bob", password: "bob-password" });
      const raw = readFileSync(storePath, "utf8");
      const parsed = JSON.parse(raw);
      const prefixes = parsed.credentials.map((credential) => credential.encryptedPassword.split(":", 1)[0]);
      const encryptionAvailable = safeStorage.isEncryptionAvailable();
      const expectedPrefix = encryptionAvailable ? "safe" : "plain";
      const checks = {
        savedTwoAccounts: store.list("default").length === 2,
        rawDoesNotExposePasswords: !raw.includes("alice-password") && !raw.includes("bob-password"),
        expectedStorageMode: prefixes.length === 2 && prefixes.every((prefix) => prefix === expectedPrefix),
      };
      result = { passed: Object.values(checks).every(Boolean), encryptionAvailable, storageMode: expectedPrefix, ...checks };
    } else if (phase === "read") {
      const records = store.list("default");
      const alice = records.find((credential) => credential.username === "alice");
      const bob = records.find((credential) => credential.username === "bob");
      const raw = JSON.parse(readFileSync(storePath, "utf8"));
      const firstEncryptedPassword = String(raw.credentials?.[0]?.encryptedPassword || "");
      let directDecryptError = "";
      if (firstEncryptedPassword.startsWith("safe:")) {
        try { safeStorage.decryptString(Buffer.from(firstEncryptedPassword.slice(5), "base64")); }
        catch (error) { directDecryptError = error instanceof Error ? error.message : String(error); }
      }
      const checks = {
        restoredTwoAccounts: records.length === 2,
        restoredAlicePassword: store.reveal("default", alice?.id)?.password === "alice-password",
        restoredBobPassword: store.reveal("default", bob?.id)?.password === "bob-password",
        profileIsolation: store.list("other-profile").length === 0,
      };
      result = {
        passed: Object.values(checks).every(Boolean),
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        storageMode: firstEncryptedPassword.split(":", 1)[0],
        ...checks,
        ...(directDecryptError ? { directDecryptError } : {}),
      };
    } else {
      throw new Error(`Unknown credential smoke phase: ${phase}`);
    }

    writeFileSync(join(work, `${phase}-result.json`), JSON.stringify(result, null, 2), "utf8");
    if (result.passed) app.quit();
    else app.exit(1);
  } catch (error) {
    writeFailure(error);
  }
}

function writeFailure(error) {
  writeFileSync(join(work, `${phase}-result.json`), JSON.stringify({ passed: false, error: error?.stack || String(error) }, null, 2), "utf8");
  app.exit(1);
}
