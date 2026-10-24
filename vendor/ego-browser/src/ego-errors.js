import { markHardStop } from "./output-sink.js";
const EGO_ERROR_CODES = [
  "EGO_BROWSER_UNAVAILABLE",
  "EGO_CDP_CHANNEL_UNAVAILABLE",
  "EGO_CDP_SEND_FAILED",
  "EGO_INVALID_ARGUMENT",
  "EGO_INVALID_RESULT_PAYLOAD",
  "EGO_OPERATION_FAILED",
  "EGO_ACTION_CONTEXT_INVALID",
  "EGO_ACTION_EXPIRED",
  "EGO_ACTION_RESULT_UNKNOWN",
  "EGO_ACTION_SCOPE_MISMATCH",
  "EGO_FRAME_UNAVAILABLE",
  "EGO_REFERENCE_DETACHED",
  "EGO_REFERENCE_STALE",
  "EGO_RESULT_CONVERSION_FAILED",
  "EGO_SNAPSHOT_FAILED",
  "EGO_TASK_HOST_DISCONNECTED",
  "EGO_TASK_SPACE_INACTIVE",
  "EGO_TASK_SPACE_NOT_FOUND",
  "EGO_TASK_SPACE_NOT_SELECTED",
  "EGO_TASK_SPACE_UNAVAILABLE",
  "EGO_TASK_SPACE_USER_IN_CONTROL",
  "EGO_WEB_CONTENTS_UNAVAILABLE"
];
const EGO_ERROR_MESSAGES = {
  EGO_TASK_SPACE_INACTIVE: [
    "The user has taken control of this task space and ended the task, so it is no longer assigned to the agent and browser commands are paused.",
    "This is a hard stop, not an obstacle to route around \u2014 do not retry and do not take ownership back on your own.",
    "Wait until the user explicitly asks you to continue, then claim the space and resume:",
    "  await taskSpaces.claim(id)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`
  ].join("\n"),
  EGO_TASK_SPACE_USER_IN_CONTROL: [
    "The user has taken control of this task space, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around \u2014 do not retry and do not take control back on your own.",
    "Wait until the user explicitly asks you to continue, then take control back and resume:",
    "  await taskSpaces.takeOver()",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`
  ].join("\n")
};
function isEgoErrorCode(value) {
  return typeof value === "string" && EGO_ERROR_CODES.includes(value);
}
function egoErrorCode(err) {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? err : void 0;
  }
  if (err && typeof err === "object") {
    const code = err.error_code;
    if (typeof code === "string" && code) return code;
  }
  return void 0;
}
function resolveEgoError(err) {
  const code = egoErrorCode(err);
  const message = (isEgoErrorCode(code) ? EGO_ERROR_MESSAGES[code] : void 0) ?? nativeErrorText(err) ?? code ?? "Unknown ego error";
  return { code, message };
}
function isEgoUserControlError(err) {
  return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}
function isEgoHardStopCode(code) {
  return code === "EGO_TASK_SPACE_USER_IN_CONTROL" || code === "EGO_TASK_SPACE_INACTIVE";
}
function isEgoHardStopError(err) {
  return isEgoHardStopCode(egoErrorCode(err));
}
function buildEgoError(err, op) {
  const { code, message } = resolveEgoError(err);
  if (isEgoHardStopCode(code)) {
    markHardStop(message);
  }
  const error = new Error(
    op ? `${op}: ${message}` : message
  );
  if (code) error.error_code = code;
  return error;
}
function assertNoEgoError(result, op) {
  if (result && typeof result === "object" && "error" in result && result.error != null) {
    throw buildEgoError(result, op);
  }
  return result;
}
function nativeErrorText(err) {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? void 0 : err;
  }
  if (err && typeof err === "object") {
    const obj = err;
    if (obj.error != null) return formatEgoError(obj.error);
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return void 0;
}
function formatEgoError(err) {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
export {
  EGO_ERROR_CODES,
  assertNoEgoError,
  buildEgoError,
  egoErrorCode,
  formatEgoError,
  isEgoErrorCode,
  isEgoHardStopError,
  isEgoUserControlError,
  resolveEgoError
};
