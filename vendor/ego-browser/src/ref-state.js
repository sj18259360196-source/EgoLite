import { parseRef, RefMap } from "./ref-map.js";
const browserRefMap = new RefMap();
let ensuring = false;
let snapshotImpl = null;
function registerSnapshotForRefRefresh(fn) {
  snapshotImpl = fn;
}
async function ensureRefMapForRef(selectorOrRef) {
  if (ensuring) return;
  if (typeof selectorOrRef !== "string") return;
  const refId = parseRef(selectorOrRef);
  if (!refId) return;
  if (browserRefMap.get(refId)) return;
  if (browserRefMap.isScopedMode() || browserRefMap.isStaleScoped(refId)) {
    throw Object.assign(new Error(`Stale scoped ref: ${refId}; take a new snapshot`), {
      error_code: "EGO_REFERENCE_STALE"
    });
  }
  if (browserRefMap.map.size > 0) return;
  if (!snapshotImpl) return;
  ensuring = true;
  try {
    await snapshotImpl();
  } finally {
    ensuring = false;
  }
}
function clearScopedReferenceState() {
  browserRefMap.clearScoped();
}
export {
  browserRefMap,
  clearScopedReferenceState,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh
};
