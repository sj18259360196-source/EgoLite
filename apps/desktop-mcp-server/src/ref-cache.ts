import type { SnapshotRef } from "../../../packages/protocol/src/types.ts";
// @ts-expect-error The vendored SDK ships JavaScript source without per-module declarations.
import { browserRefMap } from "../../../vendor/ego-browser/src/ref-state.js";

export function resolveDesktopRef(
  target: string,
  refFormat: "native-v0" | "scoped-v1",
  nativeRefs: SnapshotRef[],
  scopedScope?: { runtimeId: string; pageId: string },
): SnapshotRef {
  const publicId = Number(target.startsWith("@") ? target.slice(1) : target);
  if (!Number.isSafeInteger(publicId) || publicId <= 0) throw staleRef(target);
  if (refFormat === "native-v0") {
    const ref = nativeRefs.find((item) => item.backendNodeId === publicId);
    if (!ref) throw staleRef(target);
    return ref;
  }
  if (!scopedScope) throw staleRef(target);
  const entry = browserRefMap.get(String(publicId));
  if (!entry || entry.refFormat !== "scoped-v1"
    || entry.runtimeId !== scopedScope.runtimeId || entry.pageId !== scopedScope.pageId) {
    throw staleRef(target);
  }
  return {
    refId: publicId,
    backendNodeId: entry.backendNodeId,
    pageId: entry.pageId,
    frameId: entry.frameId,
    documentId: entry.documentId,
    documentEpoch: entry.documentEpoch,
    role: entry.role,
    name: entry.name,
  };
}

function staleRef(target: string): Error {
  return Object.assign(new Error(`Unknown desktop ref ${target}; take a new snapshot`), {
    error_code: "EGO_REFERENCE_STALE",
  });
}
