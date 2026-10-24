import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { readCosPack } from "./cos-archive.mjs";

export class CosMaintenance {
  constructor(options) {
    this.options = options;
    this.path = join(options.root, "maintenance.json");
    try { this.state = JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; this.state = { phase: "idle" }; }
    if (["preparing", "running", "cancelling", "applying"].includes(this.state.phase)) {
      this.save({ phase: "interrupted", error: "上次维护已中断，当前版本保留" });
    }
  }
  describe() { return { ...this.state }; }
  save(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    mkdirSync(this.options.root, { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(this.state, null, 2));
    renameSync(this.path + ".tmp", this.path);
    this.options.changed?.();
  }
  async check() {
    const request = this.options.fetch || fetch;
    const response = await request("https://api.github.com/repos/totec448-spec/chat-on-steroids/commits/HEAD", {
      headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`CoS 更新检查失败 (${response.status})`);
    const data = await response.json();
    if (!/^[a-f0-9]{40}$/.test(data.sha)) throw new Error("CoS 上游版本信息无效");
    this.save({ latestCommit: data.sha, updateAvailable: data.sha !== this.options.describe().commit, checkedAt: new Date().toISOString() });
    return this.describe();
  }
  async start() {
    if (["preparing", "running", "cancelling", "applying", "ready"].includes(this.state.phase)) throw new Error("已有 CoS 维护任务");
    const id = randomUUID();
    const directory = join(this.options.root, "jobs", id);
    this.save({ phase: "preparing", id, directory, error: "", candidate: null, summary: "", threadId: null });
    try {
      await mkdir(directory, { recursive: true });
      await this.options.prepare(directory);
      const current = this.options.describe();
      const prompt = `Maintain the built-in CoS component for EgoLite. Work only in ${directory}. Current version ${current.version}, upstream commit ${current.commit}. Current installed component is ${current.directory}; use it only as read-only reference.
Read builder/integrations/cos before changing anything. Fetch the latest commit from https://github.com/totec448-spec/chat-on-steroids and adapt upstream using the copied builder. Preserve the real upstream UI, hosted execution pause/stop and all features. Browser extension calls must use Ego's host bridge. Do not edit the installed Ego or current CoS files, user configuration, credentials, or profiles. Keep temporary work under .tmp/codex within this job. Use Git to record source and adapter changes.
Build a candidate inside this job with builder/integrations/cos/build-candidate.mjs. Install missing build dependencies locally. Run actual startup, UI, browser link/tab/frame, stop/restart and configuration tests in isolated data. Save command logs and verification results here. Do not claim unavailable checks passed. If Ego host changes are required or tests fail, explain and do not create candidate.json.
Only after verification, write candidate.json with {"directory":"absolute candidate path inside this job","verified":true,"summary":"changes and exact verification","evidence":["relative test log paths"]}. Never activate the candidate yourself. Ego handles program/data backup, activation and rollback. Return a concise report.`;
      await writeFile(join(directory, "REQUEST.txt"), prompt);
      this.save({ phase: "running" });
      await this.options.request("codex.stream.start", { requestId: id, workingDirectory: directory, taskId: `cos-maintenance-${id}`, prompt });
    } catch (error) { this.save({ phase: "failed", error: error.message }); throw error; }
    return this.describe();
  }
  async event(method, params) {
    if (params.requestId !== this.state.id || !["running", "cancelling"].includes(this.state.phase)) return;
    if (method === "codex.stream.event") {
      if (params.event?.type === "thread") this.save({ threadId: params.event.threadId });
      return;
    }
    if (method === "codex.stream.error" || method === "codex.stream.cancelled") {
      this.save({ phase: method.endsWith("cancelled") ? "cancelled" : "failed", error: params.message || "" });
    } else if (method === "codex.stream.complete") {
      if (this.state.phase === "cancelling") { this.save({ phase: "cancelled" }); return; }
      try {
        const receipt = JSON.parse(await readFile(join(this.state.directory, "candidate.json"), "utf8"));
        if (receipt.verified !== true || !receipt.evidence?.length) throw new Error("Agent 未提供完整验证记录");
        const candidate = await realpath(receipt.directory);
        const root = await realpath(this.state.directory);
        const inside = relative(root, candidate);
        if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("候选版本不在维护目录内");
        for (const file of receipt.evidence) {
          const evidence = relative(root, await realpath(join(root, file)));
          if (evidence.startsWith("..") || isAbsolute(evidence)) throw new Error("验证记录超出维护目录");
          await readFile(join(root, evidence));
        }
        await (this.options.validate || readCosPack)(candidate);
        this.save({ phase: "ready", candidate, summary: receipt.summary || params.text || "", error: "" });
      } catch (error) { this.save({ phase: "failed", error: error.message, summary: params.text || "" }); }
    }
  }
  async cancel() {
    if (this.state.phase !== "running") return this.describe();
    await this.options.request("codex.stream.cancel", { requestId: this.state.id });
    if (this.state.phase === "running") this.save({ phase: "cancelling" });
    return this.describe();
  }
  async apply() {
    if (this.state.phase !== "ready") throw new Error("没有通过验证的 CoS 候选版本");
    if (this.options.describe().enabled) throw new Error("请先停用 CoS，再切换版本；会话和配置会保留");
    this.save({ phase: "applying" });
    try { await this.options.update(this.state.candidate); this.save({ phase: "complete", error: "" }); }
    catch (error) { this.save({ phase: "failed", error: error.message }); throw error; }
    return this.describe();
  }
  disconnected() {
    if (["running", "cancelling"].includes(this.state.phase)) this.save({ phase: "interrupted", error: "Agent 连接中断，当前 CoS 版本保留" });
  }
}

export async function copyCosBuilder(source, destination) {
  for (const entry of ["integrations/cos", "tools/prepare-cos-pack.mjs", "tools/acquire-cos-pack.mjs",
    "apps/desktop-shell/workspace-packs/cos-runtime.mjs", "apps/desktop-shell/workspace-packs/cos-dialogs.mjs", "apps/desktop-shell/workspace-packs/cos-wire.cjs",
    "apps/desktop-shell/workspace-packs/cos-wire.d.cts",
    "apps/desktop-shell/workspace-packs/cos-archive.mjs", "apps/desktop-shell/workspace-packs/cos-download.mjs"]) {
    await mkdir(join(destination, "builder", entry, ".."), { recursive: true });
    await cp(join(source, entry), join(destination, "builder", entry), { recursive: true });
  }
}
