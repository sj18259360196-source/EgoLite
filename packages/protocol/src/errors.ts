export const EGO_ERROR_CODES = [
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
  "EGO_WEB_CONTENTS_UNAVAILABLE",
] as const;

export type EgoErrorCode = (typeof EGO_ERROR_CODES)[number];

export class EgoProtocolError extends Error {
  readonly error_code: EgoErrorCode;

  constructor(code: EgoErrorCode, message: string) {
    super(message);
    this.name = "EgoProtocolError";
    this.error_code = code;
  }
}

export function egoError(code: EgoErrorCode, message: string): never {
  throw new EgoProtocolError(code, message);
}
