// Shared by desktop status, MCP descriptions and generated interface documentation.
// Registration schemas remain the authority for tool names, arguments and defaults.
export const SCOPED_REFS_CAPABILITY = "scoped-refs-v1";
export const DEFAULT_REFERENCE_ACTION_MAX_MS = 300_000;
export const AUTOMATION_CONTRACT_VERSION = 1;

export const AUTOMATION_NOTES = Object.freeze({
  surfaces: "The full ego_* MCP and SDK operate on the selected task's tab. The ego_desktop_* MCP operates on the visible desktop page. A tool appearing in tools/list does not grant control or prove that the connected backend supports every operation.",
  refs: "When scoped-refs-v1 is negotiated, @refs identify a runtime, task, page, frame and document. Partial snapshots merge references; complete-page snapshots replace that page's reference set. Navigation, frame removal, reconnect or a page change can invalidate refs. Never reinterpret a public ref as a native backendNodeId. Without negotiation, refs use the legacy native-v0 behavior.",
  frames: "On the desktop scoped backend, use snapshot @refs for same-process, cross-process and nested iframe elements. Ordinary CSS/role locators remain rooted in the main frame. Child-frame stable locators are omitted. browser.iframeTarget() is not supported for desktop iframe discovery because Target.getTargets exposes top-level pages only.",
  drag: "Scoped drag supports exactly two refs in the same page, frame, document and native session. Cross-frame drag, mixed ref/coordinate endpoints and multi-point paths containing scoped refs are rejected.",
  screenshot: "The MCP screenshot tools capture a page, not a target ref. SDK scoped locator screenshots support the root native session and same-process frames sharing it. OOPIF element screenshots are unavailable; use a page screenshot.",
  network: "Scoped network waits observe the live sessions of the selected page at wait start. They do not promise to capture initial requests from frames created later. Response bodies use the original source session. Register the wait before triggering the request.",
  control: "Task spaces have separate tabs and control leases. Login state belongs to the selected browser Profile; spaces using that Profile can share its login state. This does not import another browser's cookies. Read-only observation grants no write access. After handoff, request and obtain control through the existing policy before writing.",
  errors: "EGO_REFERENCE_STALE requires a fresh snapshot. EGO_FRAME_UNAVAILABLE requires re-observation after the frame becomes ready. EGO_ACTION_RESULT_UNKNOWN means input may have reached the page; inspect the result and do not automatically replay it. Raw CDP remains authorized but does not gain scoped-ref identity guarantees.",
  continuous: "Keep composed SDK workflows for deterministic work. Use ego_run with explicit steps, mode repair and independent success checks when locator recovery is needed. targetHint enables local exact-label recovery, then at most one Jev target-selection decision if its non-ref locator is absent before dispatch. Intact steps use no Jev. Repair never retries an action error or invents steps; direct disables model fallback, auto retains goal-only exploration. Semantic decisions need the selected Profile's TypeSafe key and cloud consent. Use ego_extract for main-frame rows and pagination. If its connected schema supports relevance, use named extracted fields for bounded semantic screening of noisy lists; unknown rows survive. Check both complete and relevance.complete, plus unknownRows; relevance is not factual verification. Do not use a second writer during a run. Cancel with ego_automation_cancel. A done status requires verified evidence; inspect handoffs, partial extraction and unknown outcomes. Supply authorizedActions only for explicitly authorized consequential actions. These tools do not add backend capabilities.",
});

export function desktopAutomationCapabilities(scopedEnabled, maxLifetimeMs = DEFAULT_REFERENCE_ACTION_MAX_MS) {
  return {
    contractVersion: AUTOMATION_CONTRACT_VERSION,
    refFormat: scopedEnabled ? "scoped-v1" : "native-v0",
    scopedRefsEnabled: Boolean(scopedEnabled),
    snapshotRefs: scopedEnabled ? "partial-merge-complete-page-replace" : "legacy-native-ids",
    frameRefs: scopedEnabled ? "same-process-oopif-nested" : "legacy",
    locatorScope: "main-frame",
    scopedDrag: scopedEnabled ? "two-refs-same-frame-document-session" : "unavailable",
    scopedElementScreenshot: scopedEnabled ? "root-native-session-only" : "unavailable",
    scopedNetworkWait: scopedEnabled ? "sessions-present-at-wait-start" : "unavailable",
    rawCdpScopedGuarantees: false,
    ...(scopedEnabled ? { referenceActionMaxLifetimeMs: maxLifetimeMs } : {}),
  };
}

const notesByTool = {
  ego_status: ["surfaces", "control"],
  ego_desktop_status: ["surfaces", "control"],
  ego_snapshot: ["refs", "frames"],
  ego_desktop_snapshot: ["refs", "frames"],
  ego_drag: ["drag"],
  ego_screenshot: ["screenshot"],
  ego_desktop_screenshot: ["screenshot"],
  ego_click_wait_for_response: ["network"],
  ego_run: ["continuous", "control", "frames"],
  ego_extract: ["continuous"],
};

export function automationToolDescription(name, description) {
  const notes = (notesByTool[name] || []).map((key) => AUTOMATION_NOTES[key]);
  return [description, ...notes].join(" ");
}

export const AUTOMATION_SERVER_INSTRUCTIONS = [
  AUTOMATION_NOTES.surfaces, AUTOMATION_NOTES.control, AUTOMATION_NOTES.errors, AUTOMATION_NOTES.continuous,
].join("\n");
