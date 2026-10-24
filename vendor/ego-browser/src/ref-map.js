const MAX_SCOPED_REF_CACHE = 10_000;
const MAX_SCOPED_TOMBSTONES = 10_000;
class RefMap {
  map;
  mode;
  staleScopedRefs;
  scopedPageDocuments;
  constructor() {
    this.map = /* @__PURE__ */ new Map();
    this.mode = "native-v0";
    this.staleScopedRefs = /* @__PURE__ */ new Set();
    this.scopedPageDocuments = /* @__PURE__ */ new Map();
  }
  add(refId, backendNodeId, role, name, nth = void 0) {
    this.addWithFrame(refId, backendNodeId, role, name, nth, void 0);
  }
  addWithFrame(refId, backendNodeId, role, name, nth = void 0, frameId = void 0) {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      selector: void 0,
      frameId,
      refFormat: "native-v0"
    });
  }
  addScoped(refId, ref, runtimeId) {
    this.staleScopedRefs.delete(refId);
    this.map.delete(refId);
    this.map.set(refId, {
      backendNodeId: ref.backendNodeId,
      role: ref.role,
      name: ref.name,
      nth: void 0,
      selector: void 0,
      frameId: ref.frameId,
      pageId: ref.pageId,
      documentId: ref.documentId,
      documentEpoch: ref.documentEpoch,
      runtimeId,
      refFormat: "scoped-v1"
    });
    this.trimScopedCache();
  }
  beginSnapshot(refFormat, snapshot = {}) {
    if (refFormat === "scoped-v1") {
      this.mode = "scoped-v1";
      const runtimeId = nonEmptyString(snapshot.runtimeId);
      const pageId = nonEmptyString(snapshot.pageId);
      if (!runtimeId || !pageId) return;
      const pageKey = scopedPageKey(runtimeId, pageId);
      const rootDocument = scopedDocumentKey(snapshot.documentId, snapshot.documentEpoch);
      const previousDocument = this.scopedPageDocuments.get(pageKey);
      if (rootDocument && previousDocument && rootDocument !== previousDocument) {
        this.removeScopedPage(runtimeId, pageId);
      }
      if (snapshot.completeness === "complete-page") {
        this.removeScopedPage(runtimeId, pageId);
      }
      if (rootDocument) {
        this.scopedPageDocuments.delete(pageKey);
        this.scopedPageDocuments.set(pageKey, rootDocument);
        this.trimScopedPageDocuments();
      }
      return;
    } else {
      this.mode = "native-v0";
      this.staleScopedRefs.clear();
      this.scopedPageDocuments.clear();
    }
    this.map.clear();
  }
  get(refId) {
    return this.map.get(refId);
  }
  remove(refId) {
    this.map.delete(refId);
  }
  clear() {
    this.map.clear();
    this.scopedPageDocuments.clear();
  }
  clearScoped() {
    for (const [refId, entry] of this.map) {
      if (entry.refFormat !== "scoped-v1") continue;
      this.markScopedStale(refId);
      this.map.delete(refId);
    }
    this.scopedPageDocuments.clear();
  }
  isScopedMode() {
    return this.mode === "scoped-v1";
  }
  isStaleScoped(refId) {
    return this.staleScopedRefs.has(refId) || this.mode === "scoped-v1" && !this.map.has(refId);
  }
  removeScopedPage(runtimeId, pageId) {
    for (const [refId, entry] of this.map) {
      if (entry.refFormat !== "scoped-v1" || entry.runtimeId !== runtimeId || entry.pageId !== pageId) continue;
      this.markScopedStale(refId);
      this.map.delete(refId);
    }
    this.scopedPageDocuments.delete(scopedPageKey(runtimeId, pageId));
  }
  trimScopedPageDocuments() {
    while (this.scopedPageDocuments.size > MAX_SCOPED_REF_CACHE) {
      const oldestPage = this.scopedPageDocuments.keys().next().value;
      if (oldestPage === void 0) break;
      // Forgetting a page document must also revoke any refs still cached for it.
      const [runtimeId, pageId] = JSON.parse(oldestPage);
      this.removeScopedPage(runtimeId, pageId);
    }
  }
  markScopedStale(refId) {
    this.staleScopedRefs.delete(refId);
    this.staleScopedRefs.add(refId);
    while (this.staleScopedRefs.size > MAX_SCOPED_TOMBSTONES) {
      const oldest = this.staleScopedRefs.values().next().value;
      if (oldest === void 0) break;
      this.staleScopedRefs.delete(oldest);
    }
  }
  trimScopedCache() {
    let scopedCount = 0;
    for (const entry of this.map.values()) if (entry.refFormat === "scoped-v1") scopedCount++;
    if (scopedCount <= MAX_SCOPED_REF_CACHE) return;
    for (const [refId, entry] of this.map) {
      if (entry.refFormat !== "scoped-v1") continue;
      this.map.delete(refId);
      this.markScopedStale(refId);
      scopedCount--;
      if (scopedCount <= MAX_SCOPED_REF_CACHE) break;
    }
  }
}
function nonEmptyString(value) {
  return typeof value === "string" && value ? value : null;
}
function scopedPageKey(runtimeId, pageId) {
  return JSON.stringify([runtimeId, pageId]);
}
function scopedDocumentKey(documentId, documentEpoch) {
  return nonEmptyString(documentId) && Number.isSafeInteger(documentEpoch)
    ? JSON.stringify([documentId, documentEpoch])
    : null;
}
function parseRef(input) {
  const trimmed = String(input || "").trim();
  for (const candidate of [
    trimmed.startsWith("@") ? trimmed.slice(1) : null,
    trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
    trimmed
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
export {
  RefMap,
  parseRef
};
