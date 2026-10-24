import test from "node:test";
import assert from "node:assert/strict";
import { CosDialogs, COS_DIALOG_CHANNELS } from "./cos-dialogs.mjs";

function fixture() {
  const calls = [];
  const parent = { isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") };
  const options = { getParent: () => parent, enabled: () => true, dialog: {
    showOpenDialog: async (owner, input) => { calls.push({ owner, input }); return { canceled: false, filePaths: ["chosen"] }; },
    showSaveDialog: async (owner, input) => { calls.push({ owner, input }); return { canceled: false, filePath: "saved" }; },
  } };
  return { options, calls, parent, service: new CosDialogs(options) };
}

test("open directory, multi-file and save dialogs use the visible Ego owner and preserve options/results", async () => {
  const { service, calls, parent } = fixture();
  for (const properties of [["openDirectory"], ["openFile", "multiSelections"]]) {
    const input = { properties, defaultPath: "previous", filters: [{ name: "Text", extensions: ["txt"] }] };
    assert.deepEqual(await service.show("dialog.open", input), { canceled: false, filePaths: ["chosen"] });
    assert.deepEqual(calls.splice(0), ["restore", "show", "focus", { owner: parent, input }]);
  }
  assert.equal((await service.show("dialog.save", { defaultPath: "report.md" })).filePath, "saved");
  assert.equal(COS_DIALOG_CHANNELS.has("sessions:exportMarkdown"), true);
});

test("stop drops late selections and queued dialogs; errors do not block subsequent dialogs", async () => {
  const { service, options } = fixture();
  let finish;
  options.dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
  const pending = service.show("dialog.open");
  const queued = service.show("dialog.save");
  await new Promise(resolve => setImmediate(resolve));
  service.stop();
  finish({ canceled: false, filePaths: ["must-not-return"] });
  assert.deepEqual(await pending, { canceled: true, filePaths: [] });
  assert.deepEqual(await queued, { canceled: true, filePath: "" });
  await assert.rejects(service.show("dialog.open", []), /Invalid/);
  assert.equal((await service.show("dialog.save")).filePath, "saved");
  options.enabled = () => false;
  assert.deepEqual(await service.show("dialog.open"), { canceled: true, filePaths: [] });
});
