const NOTICE_PREFIX = "[ego-browser:notice]";
const NOTICE_PROBE_TIMEOUT_MS = 2e3;
function noticeSuppressed(env = process.env) {
  return Boolean(env.EGO_BROWSER_NO_UPDATE_NOTIFIER || env.CI);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function composeNotice(info) {
  if (!info || info.updateAvailable !== true || !isNonEmptyString(info.currentVersion)) {
    return null;
  }
  const target = isNonEmptyString(info.latestVersion) ? `ego lite ${info.latestVersion}` : "an ego lite update";
  const urgency = info.mandatory === true ? "is required" : "is available";
  return `${NOTICE_PREFIX} ${target} ${urgency} (current ${info.currentVersion}) \u2014 run: ego-browser upgrade in your shell, then re-read the ego-browser skill`;
}
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function updateNoticeLine(options) {
  if (noticeSuppressed(options.env || process.env)) return null;
  try {
    const info = await withTimeout(
      Promise.resolve(options.source()),
      options.timeoutMs ?? NOTICE_PROBE_TIMEOUT_MS
    );
    return composeNotice(info);
  } catch {
    return null;
  }
}
function emitUpdateNotice(ego, emit, env) {
  updateNoticeLine({
    source: () => ego?.getBrowserVersion?.() ?? Promise.resolve(null),
    env
  }).then((line) => {
    if (line) emit(line);
  }).catch(() => {
  });
}
export {
  NOTICE_PREFIX,
  NOTICE_PROBE_TIMEOUT_MS,
  composeNotice,
  emitUpdateNotice,
  noticeSuppressed,
  updateNoticeLine
};
