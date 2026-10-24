import type { SnapshotRef } from "../../../packages/protocol/src/types.ts";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap } from "../../../vendor/ego-browser/src/ref-state.js";

export function resolveDesktopScopedRef(target: string, runtimeId?: string, pageId?: string): SnapshotRef {
  const publicId = Number(target.slice(1));
  const ref = browserRefMap.get(String(publicId));
  if (!Number.isSafeInteger(publicId) || publicId <= 0 || !runtimeId || !pageId
    || ref?.refFormat !== "scoped-v1" || ref.runtimeId !== runtimeId || ref.pageId !== pageId) {
    throw Object.assign(new Error(`Unknown desktop ref ${target}; take a new snapshot`), {
      error_code: "EGO_REFERENCE_STALE",
    });
  }
  return { ...ref, refId: publicId };
}
