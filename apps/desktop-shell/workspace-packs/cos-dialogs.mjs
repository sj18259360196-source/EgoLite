export const COS_DIALOG_CHANNELS = new Set([
  "roots:add", "projects:add", "pets:import", "skills:import", "binary:pick",
  "sessions:files", "sessions:exportMarkdown", "plugins:importBundle", "diagnostics:saveReport", "usage:export", "code:save",
]);

export class CosDialogs {
  #generation = 0;
  #queue = Promise.resolve();
  constructor(options) { this.options = options; }
  stop() { this.#generation++; }
  show(method, options = {}) {
    if (!["dialog.open", "dialog.save"].includes(method)) return Promise.reject(new Error("Unsupported CoS dialog"));
    const generation = this.#generation;
    const cancelled = () => method === "dialog.open" ? { canceled: true, filePaths: [] } : { canceled: true, filePath: "" };
    const current = () => generation === this.#generation && this.options.enabled();
    const run = this.#queue.then(async () => {
      if (!current()) return cancelled();
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid CoS dialog options");
      const parent = this.options.getParent();
      if (!parent || parent.isDestroyed()) throw new Error("Ego window is unavailable");
      if (parent.isMinimized()) parent.restore();
      parent.show();
      parent.focus();
      const result = await this.options.dialog[method === "dialog.open" ? "showOpenDialog" : "showSaveDialog"](parent, options);
      return current() ? result : cancelled();
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}
