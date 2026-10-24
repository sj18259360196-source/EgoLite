# EgoLite automation interface reference

Generated from both MCP servers' actual tools/list responses and the SDK facade. Do not edit generated sections.
Run `npm run docs:automation` to regenerate, or `npm run check:automation` to detect drift.

## Capability discovery

Call `ego_status` and inspect `backend.capabilities` and `backend.automation`; for the direct MCP use `ego_desktop_status` and its top-level fields.
The declaration describes the current desktop backend. SDK method presence and MCP tools/list describe available interfaces, not runtime permission or support on other backends.
`scoped-refs-v1` still requires per-connection negotiation. `EGO_SCOPED_REFS=0` disables it. The action lifetime is reported at runtime and may be configured with `EGO_REFERENCE_ACTION_MAX_MS`.

### Desktop declaration with scoped refs enabled

```json
{
  "contractVersion": 1,
  "refFormat": "scoped-v1",
  "scopedRefsEnabled": true,
  "snapshotRefs": "partial-merge-complete-page-replace",
  "frameRefs": "same-process-oopif-nested",
  "locatorScope": "main-frame",
  "scopedDrag": "two-refs-same-frame-document-session",
  "scopedElementScreenshot": "root-native-session-only",
  "scopedNetworkWait": "sessions-present-at-wait-start",
  "rawCdpScopedGuarantees": false,
  "referenceActionMaxLifetimeMs": 300000
}
```

### surfaces

The full ego_* MCP and SDK operate on the selected task's tab. The ego_desktop_* MCP operates on the visible desktop page. A tool appearing in tools/list does not grant control or prove that the connected backend supports every operation.

### refs

When scoped-refs-v1 is negotiated, @refs identify a runtime, task, page, frame and document. Partial snapshots merge references; complete-page snapshots replace that page's reference set. Navigation, frame removal, reconnect or a page change can invalidate refs. Never reinterpret a public ref as a native backendNodeId. Without negotiation, refs use the legacy native-v0 behavior.

### frames

On the desktop scoped backend, use snapshot @refs for same-process, cross-process and nested iframe elements. Ordinary CSS/role locators remain rooted in the main frame. Child-frame stable locators are omitted. browser.iframeTarget() is not supported for desktop iframe discovery because Target.getTargets exposes top-level pages only.

### drag

Scoped drag supports exactly two refs in the same page, frame, document and native session. Cross-frame drag, mixed ref/coordinate endpoints and multi-point paths containing scoped refs are rejected.

### screenshot

The MCP screenshot tools capture a page, not a target ref. SDK scoped locator screenshots support the root native session and same-process frames sharing it. OOPIF element screenshots are unavailable; use a page screenshot.

### network

Scoped network waits observe the live sessions of the selected page at wait start. They do not promise to capture initial requests from frames created later. Response bodies use the original source session. Register the wait before triggering the request.

### control

Task spaces have separate tabs and control leases. Login state belongs to the selected browser Profile; spaces using that Profile can share its login state. This does not import another browser's cookies. Read-only observation grants no write access. After handoff, request and obtain control through the existing policy before writing.

### errors

EGO_REFERENCE_STALE requires a fresh snapshot. EGO_FRAME_UNAVAILABLE requires re-observation after the frame becomes ready. EGO_ACTION_RESULT_UNKNOWN means input may have reached the page; inspect the result and do not automatically replay it. Raw CDP remains authorized but does not gain scoped-ref identity guarantees.

### continuous

Keep composed SDK workflows for deterministic work. Use ego_run with explicit steps, mode repair and independent success checks when locator recovery is needed. targetHint enables local exact-label recovery, then at most one Jev target-selection decision if its non-ref locator is absent before dispatch. Intact steps use no Jev. Repair never retries an action error or invents steps; direct disables model fallback, auto retains goal-only exploration. Semantic decisions need the selected Profile's TypeSafe key and cloud consent. Use ego_extract for main-frame rows and pagination. If its connected schema supports relevance, use named extracted fields for bounded semantic screening of noisy lists; unknown rows survive. Check both complete and relevance.complete, plus unknownRows; relevance is not factual verification. Do not use a second writer during a run. Cancel with ego_automation_cancel. A done status requires verified evidence; inspect handoffs, partial extraction and unknown outcomes. Supply authorizedActions only for explicitly authorized consequential actions. These tools do not add backend capabilities.

## Snapshot defaults

Defaults come from the actual MCP schemas and the SDK option-normalization function.

| Entry point | Default options |
| --- | --- |
| Full MCP ego_snapshot | {"scope":"viewport","stableLocators":true} |
| Direct MCP ego_desktop_snapshot | {"scope":"full_page","stableLocators":false,"actionMarks":true} |
| SDK page.snapshot() | {"scope":"full_page","includeActionMarks":true,"includeStableLocator":true} |

SDK uses `includeStableLocator`, `includeActionMarks` and `maxResultLength`; MCP uses `stableLocators` and, where offered, `actionMarks`.
`actionMarks=false` / `includeActionMarks=false` removes the inline @ref markers. Do not parse refs out of that text. Complete-page results require an untruncated full capture; unavailable frames are reported as incomplete.
Snapshot text is returned by the MCP tools and SDK page.snapshot(); structured refs and completeness are available from the runtime snapshot response, not a JSON shape invented for the text tools.

## Full task-space MCP

45 registered tools.

### ego_agent_status

Read Agent connection and browser activity known to Ego. External Codex Desktop conversations are unavailable without a status provider.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| clientId | string | no | — | {"maxLength":256} |
| sourceScope | string | no | "ego" | {"enum":["ego","codex-desktop"]} |

### ego_automation_cancel

Cancel this MCP session's continuous task. Already dispatched operations may have happened; observe their results before retrying.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_browser_fetch

Run fetch inside the current page origin so browser cookies, CORS, and session state apply.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| url | string | yes | — | {"minLength":1} |
| method | string | no | "GET" | {"minLength":1} |
| headers | object | no | {} | {"propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}} |
| body | string | no | — | {} |
| credentials | string | no | "same-origin" | {"enum":["omit","same-origin","include"]} |
| timeout | number | no | 20 | {"minimum":0.1,"maximum":120} |
| parse | string | no | "auto" | {"enum":["auto","json","text"]} |

### ego_check

Set a checkbox or radio element to the requested checked state.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| checked | boolean | no | true | {} |

### ego_click

Click one element using an @ref from the latest snapshot or a strict locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| button | string | no | "left" | {"enum":["left","right","middle"]} |
| clickCount | integer | no | 1 | {"minimum":1,"maximum":3} |

### ego_click_new_tab

Click an element, wait for a newly opened tab or popup, and optionally select it.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| timeout | integer | no | 20000 | {"minimum":1000,"maximum":120000} |
| select | boolean | no | true | {} |

### ego_click_wait_for_response

Atomically start waiting for a matching network response, click an element, and return response details. Scoped network waits observe the live sessions of the selected page at wait start. They do not promise to capture initial requests from frames created later. Response bodies use the original source session. Register the wait before triggering the request.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| url | string | yes | — | {"minLength":1} |
| match | string | no | "contains" | {"enum":["exact","contains","regex"]} |
| method | string | no | — | {"minLength":1} |
| status | integer | no | — | {"minimum":100,"maximum":599} |
| timeout | integer | no | 20000 | {"minimum":100,"maximum":120000} |
| bodyLimit | integer | no | 100000 | {"minimum":0,"maximum":1000000} |

### ego_dialog_respond

Accept or dismiss the currently open JavaScript dialog, with optional prompt text.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| accept | boolean | no | true | {} |
| promptText | string | no | — | {} |

### ego_dialog_status

Inspect the currently open JavaScript alert, confirm, prompt, or before-unload dialog.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_double_click

Double-click one element using an @ref from the latest snapshot or a strict locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |

### ego_download

Click a download element and wait for the file to complete, optionally saving it to a local path.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| saveAs | string | no | — | {"minLength":1} |
| timeout | integer | no | 30000 | {"minimum":1000,"maximum":120000} |

### ego_drag

Drag one element to another element using current snapshot @refs or strict locators. Scoped drag supports exactly two refs in the same page, frame, document and native session. Cross-frame drag, mixed ref/coordinate endpoints and multi-point paths containing scoped refs are rejected.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| source | string | yes | — | {"minLength":1} |
| target | string | yes | — | {"minLength":1} |
| delay | integer | no | 50 | {"minimum":0,"maximum":2000} |

### ego_evaluate

Evaluate a JavaScript expression in the current page and return its JSON-serializable value.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| expression | string | yes | — | {"minLength":1,"maxLength":100000} |

### ego_extract

Read table/list rows with optional pagination. Pass task to select an existing task by name/ID in this MCP session; SDK selection is separate. maxPages is 1-30, maxRows is 1-5000. Fields use CSS selectors relative to each row. Optional relevance sends only its named extracted fields to Jev in bounded batches with the selected Profile's cloud consent. It excludes confidently irrelevant rows, always retains unknown rows, and returns original rowIndices, per-row judgments and sourceIndex provenance. complete covers collection; also inspect relevance.complete and unknownRows. Model relevance is not factual verification. Without relevance, no model is used. Keep composed SDK workflows for deterministic work. Use ego_run with explicit steps, mode repair and independent success checks when locator recovery is needed. targetHint enables local exact-label recovery, then at most one Jev target-selection decision if its non-ref locator is absent before dispatch. Intact steps use no Jev. Repair never retries an action error or invents steps; direct disables model fallback, auto retains goal-only exploration. Semantic decisions need the selected Profile's TypeSafe key and cloud consent. Use ego_extract for main-frame rows and pagination. If its connected schema supports relevance, use named extracted fields for bounded semantic screening of noisy lists; unknown rows survive. Check both complete and relevance.complete, plus unknownRows; relevance is not factual verification. Do not use a second writer during a run. Cancel with ego_automation_cancel. A done status requires verified evidence; inspect handoffs, partial extraction and unknown outcomes. Supply authorizedActions only for explicitly authorized consequential actions. These tools do not add backend capabilities.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | no | — | {"anyOf":[{"type":"string","minLength":1,"maxLength":200},{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}]} |
| selector | string | yes | — | {"minLength":1,"maxLength":2000} |
| fields | object | yes | — | {"propertyNames":{"type":"string","minLength":1,"maxLength":100},"additionalProperties":{"type":"object","properties":{"selector":{"default":"","type":"string","maxLength":2000},"attribute":{"default":"text","type":"string","enum":["text","href","src","value","datetime","title"]}},"additionalProperties":false}} |
| maxRows | integer | no | 500 | {"minimum":1,"maximum":5000} |
| next | string | no | — | {"maxLength":2000} |
| maxPages | integer | no | 1 | {"minimum":1,"maximum":30} |
| timeoutMs | integer | no | 45000 | {"minimum":1000,"maximum":120000} |
| relevance | object | no | — | {"properties":{"query":{"type":"string","minLength":1,"maxLength":4000},"fields":{"minItems":1,"maxItems":8,"type":"array","items":{"type":"string","minLength":1,"maxLength":100}},"batchSize":{"default":20,"type":"integer","minimum":1,"maximum":40},"maxCandidates":{"default":200,"type":"integer","minimum":1,"maximum":1000},"maxDecisions":{"default":10,"type":"integer","minimum":1,"maximum":60},"maxTextChars":{"default":1000,"type":"integer","minimum":100,"maximum":2000}},"required":["query","fields"],"additionalProperties":false} |

### ego_fill

Replace the value of an editable element identified by @ref or locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| value | string | yes | — | {} |

### ego_hover

Hover an element using an @ref from the latest snapshot or a strict locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |

### ego_inspect

Read text, value, state, and selected attributes from one element identified by @ref or locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| attributes | array | no | [] | {"maxItems":32,"items":{"type":"string","minLength":1}} |

### ego_navigate

Navigate the current tab backward, forward, or reload it and optionally wait for loading.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| action | string | yes | — | {"enum":["back","forward","reload"]} |
| waitUntil | string | no | "load" | {"enum":["load","domcontentloaded","commit"]} |
| ignoreCache | boolean | no | false | {} |
| timeout | integer | no | 20000 | {"minimum":1000,"maximum":120000} |

### ego_open

Open or reuse a tab at a URL in the selected Ego task space and wait for loading.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| url | string | yes | — | {"format":"uri"} |
| wait | boolean | no | true | {} |
| match | string | no | "exact" | {"enum":["exact","origin","origin+path","includes"]} |

### ego_package_status

Read CoS runtime, queued-task metadata and recent session summaries. Does not imply that a task has completed.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| packageId | string | no | "cos" | {"const":"cos"} |
| instanceId | string | no | — | {"const":"default"} |

### ego_package_wait

Wait up to 25 seconds for CoS metadata events. Reuse its cursor; a timeout does not mean task completion.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| instanceId | string | no | — | {"const":"default"} |
| afterCursor | string | no | — | {"maxLength":128} |
| timeoutMs | integer | no | 0 | {"minimum":0,"maximum":25000} |

### ego_page_info

Read the current page URL, title, viewport, scroll position, and document dimensions.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_press

Press a key on a target element, or on the page when target is omitted.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| key | string | yes | — | {"minLength":1} |
| target | string | no | — | {"minLength":1} |

### ego_run

Complete a bounded browser subtask. Pass task to select an existing task by name/ID; SDK selection is separate. Keep an existing composed SDK workflow for deterministic work. For explicit plans needing locator recovery, use mode repair and targetHint: intact targets or exact unique labels run locally; an absent non-ref target may receive one Jev target-selection decision before dispatch. Repair never retries failed actions or adds unplanned actions. Use direct for no model fallback, auto only for deliberate goal-only exploration. Requires structural success checks. Only include authorizedActions explicitly authorized by the user. Returns verified evidence or a handoff; never replay unknown results. Keep composed SDK workflows for deterministic work. Use ego_run with explicit steps, mode repair and independent success checks when locator recovery is needed. targetHint enables local exact-label recovery, then at most one Jev target-selection decision if its non-ref locator is absent before dispatch. Intact steps use no Jev. Repair never retries an action error or invents steps; direct disables model fallback, auto retains goal-only exploration. Semantic decisions need the selected Profile's TypeSafe key and cloud consent. Use ego_extract for main-frame rows and pagination. If its connected schema supports relevance, use named extracted fields for bounded semantic screening of noisy lists; unknown rows survive. Check both complete and relevance.complete, plus unknownRows; relevance is not factual verification. Do not use a second writer during a run. Cancel with ego_automation_cancel. A done status requires verified evidence; inspect handoffs, partial extraction and unknown outcomes. Supply authorizedActions only for explicitly authorized consequential actions. These tools do not add backend capabilities. Task spaces have separate tabs and control leases. Login state belongs to the selected browser Profile; spaces using that Profile can share its login state. This does not import another browser's cookies. Read-only observation grants no write access. After handoff, request and obtain control through the existing policy before writing. On the desktop scoped backend, use snapshot @refs for same-process, cross-process and nested iframe elements. Ordinary CSS/role locators remain rooted in the main frame. Child-frame stable locators are omitted. browser.iframeTarget() is not supported for desktop iframe discovery because Target.getTargets exposes top-level pages only.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | no | — | {"anyOf":[{"type":"string","minLength":1,"maxLength":200},{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}]} |
| goal | string | yes | — | {"minLength":1,"maxLength":4000} |
| values | object | no | {} | {"propertyNames":{"type":"string","minLength":1,"maxLength":100},"additionalProperties":{"type":"string","maxLength":20000}} |
| steps | array | no | [] | {"maxItems":100,"items":{"type":"object","properties":{"action":{"type":"string","enum":["click","fill","select","check","uncheck","press","hover","scroll","navigate","wait","upload"]},"target":{"type":"string","minLength":1,"maxLength":2000},"targetHint":{"type":"string","minLength":1,"maxLength":500},"valueKey":{"type":"string","minLength":1,"maxLength":100},"value":{"type":"string","maxLength":20000},"deltaY":{"type":"number","minimum":-10000,"maximum":10000},"waitFor":{"type":"object","properties":{"kind":{"type":"string","enum":["url_contains","url_path_contains","title_contains","visible","hidden","text_contains","value_equals","checked","count_equals","filter_value"]},"target":{"type":"string","minLength":1,"maxLength":2000},"name":{"type":"string","maxLength":200},"value":{"anyOf":[{"type":"string","maxLength":20000},{"type":"integer","minimum":0,"maximum":9007199254740991},{"type":"boolean"}]}},"required":["kind"],"additionalProperties":false},"consequential":{"type":"boolean"}},"required":["action"],"additionalProperties":false}} |
| success | object | yes | — | {"properties":{"all":{"minItems":1,"maxItems":20,"type":"array","items":{"type":"object","properties":{"kind":{"type":"string","enum":["url_contains","url_path_contains","title_contains","visible","hidden","text_contains","value_equals","checked","count_equals","filter_value"]},"target":{"type":"string","minLength":1,"maxLength":2000},"name":{"type":"string","maxLength":200},"value":{"anyOf":[{"type":"string","maxLength":20000},{"type":"integer","minimum":0,"maximum":9007199254740991},{"type":"boolean"}]}},"required":["kind"],"additionalProperties":false}}},"required":["all"],"additionalProperties":false} |
| allowedOrigins | array | no | — | {"maxItems":30,"items":{"type":"string","format":"uri"}} |
| authorizedActions | array | no | [] | {"maxItems":5,"items":{"type":"string","enum":["submit","delete","purchase","send","upload"]}} |
| mode | string | no | "auto" | {"enum":["auto","direct","repair"]} |
| budget | object | no | {"maxActions":24,"maxDecisions":18,"timeoutMs":45000} | {"properties":{"maxActions":{"default":24,"type":"integer","minimum":1,"maximum":100},"maxDecisions":{"default":18,"type":"integer","minimum":1,"maximum":60},"timeoutMs":{"default":45000,"type":"integer","minimum":1000,"maximum":120000}}} |

### ego_screenshot

Capture the current page and return a PNG for visual inspection. The MCP screenshot tools capture a page, not a target ref. SDK scoped locator screenshots support the root native session and same-process frames sharing it. OOPIF element screenshots are unavailable; use a page screenshot.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| fullPage | boolean | no | false | {} |

### ego_scroll

Scroll the page by CSS-pixel deltas, or reveal a target element.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| deltaX | number | no | 0 | {} |
| deltaY | number | no | 500 | {} |
| target | string | no | — | {"minLength":1} |

### ego_select

Select one or more values in a select element identified by @ref or locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| values | array | yes | — | {"minItems":1,"items":{"type":"string"}} |

### ego_snapshot

Return an accessibility-first page snapshot with actionable @refs for later actions. When scoped-refs-v1 is negotiated, @refs identify a runtime, task, page, frame and document. Partial snapshots merge references; complete-page snapshots replace that page's reference set. Navigation, frame removal, reconnect or a page change can invalidate refs. Never reinterpret a public ref as a native backendNodeId. Without negotiation, refs use the legacy native-v0 behavior. On the desktop scoped backend, use snapshot @refs for same-process, cross-process and nested iframe elements. Ordinary CSS/role locators remain rooted in the main frame. Child-frame stable locators are omitted. browser.iframeTarget() is not supported for desktop iframe discovery because Target.getTargets exposes top-level pages only.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| scope | string | no | "viewport" | {"enum":["viewport","full_page"]} |
| stableLocators | boolean | no | true | {} |
| maxResultLength | integer | no | — | {"minimum":64,"maximum":9007199254740991} |

### ego_status

Inspect Ego backend readiness, task spaces, and the selected task's tabs before browser work. The full ego_* MCP and SDK operate on the selected task's tab. The ego_desktop_* MCP operates on the visible desktop page. A tool appearing in tools/list does not grant control or prove that the connected backend supports every operation. Task spaces have separate tabs and control leases. Login state belongs to the selected browser Profile; spaces using that Profile can share its login state. This does not import another browser's cookies. Read-only observation grants no write access. After handoff, request and obtain control through the existing policy before writing.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_tab_close

Close a tab in the selected task by current target id, title, or URL.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |

### ego_tab_select

Switch the selected task to a tab by current target id, title, or URL.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |

### ego_tabs

List tabs in the selected Ego task space.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_task_close

Close a browser task and all of its tabs after verified work is complete.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | yes | — | {"anyOf":[{"type":"string"},{"type":"number"}]} |

### ego_task_complete

Complete a browser task and either keep it for the user or close it after verified work.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | yes | — | {"anyOf":[{"type":"string"},{"type":"number"}]} |
| keep | boolean | no | true | {} |

### ego_task_handoff

Hand the selected browser task to the user and stop agent browser mutations.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_task_observe

Read workspace control state and tabs without selecting it or obtaining write access. Optionally capture a read-only snapshot of a tab in that workspace.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | yes | — | {"anyOf":[{"type":"string"},{"type":"number"}]} |
| targetId | string | no | — | {} |

### ego_task_request_control

Request write access; the user or current writer must explicitly approve the handoff.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | yes | — | {"anyOf":[{"type":"string"},{"type":"number"}]} |

### ego_task_return_control

Release this Agent's write access to the user or approve a pending request from another Agent.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | yes | — | {"anyOf":[{"type":"string"},{"type":"number"}]} |
| requestId | string | no | — | {} |

### ego_task_use

Select an existing Ego task space by name/id or create it when missing.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| task | union | yes | — | {"anyOf":[{"type":"string"},{"type":"number"}]} |

### ego_type

Type text sequentially into an editable element, preserving keyboard events.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| text | string | yes | — | {} |
| delay | integer | no | 0 | {"minimum":0,"maximum":1000} |

### ego_upload

Set one or more existing local files on a file input identified by @ref or locator.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"minLength":1} |
| paths | array | yes | — | {"minItems":1,"items":{"type":"string","minLength":1}} |

### ego_wait

Wait for page loading or for a short bounded duration after an action.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| loadState | string | no | — | {"enum":["load","domcontentloaded","networkidle"]} |
| milliseconds | integer | no | 500 | {"minimum":0,"maximum":10000} |

### ego_wait_for

Wait until a URL, element state, or text condition is satisfied without relying on a fixed sleep.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| url | string | no | — | {"minLength":1} |
| target | string | no | — | {"minLength":1} |
| text | string | no | — | {} |
| state | string | no | — | {"enum":["attached","visible","hidden","detached"]} |
| timeout | integer | no | 20000 | {"minimum":0,"maximum":120000} |
| polling | integer | no | 100 | {"minimum":20,"maximum":2000} |

### ego_webmcp_call

Call one WebMCP tool exposed by the current page. Discover tools first with ego_webmcp_tools.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| tool | string | yes | — | {"minLength":1,"maxLength":256} |
| input | object | no | {} | {"propertyNames":{"type":"string"},"additionalProperties":{}} |

### ego_webmcp_tools

List the WebMCP tools exposed by the current page through document.modelContext.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

## Direct visible-page MCP

22 registered tools.

### ego_agent_status

Read Agent connection and browser activity known to Ego. External Codex Desktop conversations are unavailable without a status provider.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| clientId | string | no | — | {"maxLength":256} |
| sourceScope | string | no | "ego" | {"enum":["ego","codex-desktop"]} |

### ego_desktop_click

Click an element in the visible Ego page using an @ref from the latest snapshot.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"pattern":"^@\\d+$"} |

### ego_desktop_close_tab

Close a visible Ego tab by target id, or close the active tab when omitted.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| targetId | string | no | — | {"minLength":1} |

### ego_desktop_evaluate

Evaluate a JSON-serializable JavaScript expression in the visible Ego page.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| expression | string | yes | — | {"minLength":1,"maxLength":100000} |

### ego_desktop_fill

Fill an editable element in the visible Ego page using an @ref from the latest snapshot.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"pattern":"^@\\d+$"} |
| value | string | yes | — | {} |

### ego_desktop_hover

Hover an element in the visible Ego page using an @ref from the latest snapshot.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| target | string | yes | — | {"pattern":"^@\\d+$"} |

### ego_desktop_navigate

Navigate the visible Ego page backward, forward, or reload.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| action | string | yes | — | {"enum":["back","forward","reload"]} |

### ego_desktop_new_tab

Create and activate a new tab in the visible Ego task space.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| url | string | no | — | {"minLength":1} |

### ego_desktop_open

Navigate the visible Ego desktop page to a URL or search query.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| url | string | yes | — | {"minLength":1} |

### ego_desktop_page_info

Read title, URL, loading state, and navigation availability from the visible Ego page.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_desktop_press

Send a key or keyboard shortcut to the visible Ego page.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| key | string | yes | — | {"minLength":1,"maxLength":100} |

### ego_desktop_request_control

Request write access to the visible workspace. The user must approve this Agent in the desktop control panel before page operations can proceed.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_desktop_screenshot

Capture the visible Ego page as a PNG. The MCP screenshot tools capture a page, not a target ref. SDK scoped locator screenshots support the root native session and same-process frames sharing it. OOPIF element screenshots are unavailable; use a page screenshot.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_desktop_scroll

Scroll the visible Ego page by pixel deltas.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| deltaY | number | yes | — | {"minimum":-100000,"maximum":100000} |
| deltaX | number | no | 0 | {"minimum":-100000,"maximum":100000} |

### ego_desktop_snapshot

Capture an accessibility snapshot of the visible Ego page and create actionable @refs. When scoped-refs-v1 is negotiated, @refs identify a runtime, task, page, frame and document. Partial snapshots merge references; complete-page snapshots replace that page's reference set. Navigation, frame removal, reconnect or a page change can invalidate refs. Never reinterpret a public ref as a native backendNodeId. Without negotiation, refs use the legacy native-v0 behavior. On the desktop scoped backend, use snapshot @refs for same-process, cross-process and nested iframe elements. Ordinary CSS/role locators remain rooted in the main frame. Child-frame stable locators are omitted. browser.iframeTarget() is not supported for desktop iframe discovery because Target.getTargets exposes top-level pages only.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| scope | string | no | "full_page" | {"enum":["viewport","full_page"]} |
| stableLocators | boolean | no | false | {} |
| actionMarks | boolean | no | true | {} |
| maxResultLength | integer | no | — | {"minimum":64,"maximum":9007199254740991} |

### ego_desktop_status

Check whether the visible Ego desktop browser is available. The full ego_* MCP and SDK operate on the selected task's tab. The ego_desktop_* MCP operates on the visible desktop page. A tool appearing in tools/list does not grant control or prove that the connected backend supports every operation. Task spaces have separate tabs and control leases. Login state belongs to the selected browser Profile; spaces using that Profile can share its login state. This does not import another browser's cookies. Read-only observation grants no write access. After handoff, request and obtain control through the existing policy before writing.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_desktop_switch_tab

Activate a visible Ego tab by target id.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| targetId | string | yes | — | {"minLength":1} |

### ego_desktop_tabs

List tabs in the currently visible Ego task space.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| (none) | | | | |

### ego_desktop_type

Type text into the currently focused element in the visible Ego page.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| text | string | yes | — | {"maxLength":100000} |

### ego_desktop_wait

Wait until the visible page finishes loading or matches URL and text conditions.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| timeout | integer | no | 10000 | {"minimum":100,"maximum":60000} |
| loadComplete | boolean | no | true | {} |
| urlContains | string | no | — | {"maxLength":10000} |
| text | string | no | — | {"maxLength":100000} |

### ego_package_status

Read CoS runtime, queued-task metadata and recent session summaries. Does not imply that a task has completed.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| packageId | string | no | "cos" | {"const":"cos"} |
| instanceId | string | no | — | {"const":"default"} |

### ego_package_wait

Wait up to 25 seconds for CoS metadata events. Reuse its cursor; a timeout does not mean task completion.

| Argument | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| instanceId | string | no | — | {"const":"default"} |
| afterCursor | string | no | — | {"maxLength":128} |
| timeoutMs | integer | no | 0 | {"minimum":0,"maximum":25000} |

## SDK method inventory

These are actual facade methods. Use SDK `help()` for signatures. A method may still report unsupported on a given backend.

- page: `dialogInfo`, `drainEvents`, `elementCenter`, `evaluate`, `getByAltText`, `getByLabel`, `getByPlaceholder`, `getByRole`, `getByTestId`, `getByText`, `getByTitle`, `goBack`, `goForward`, `goto`, `handleDialog`, `info`, `locator`, `reload`, `screenshot`, `setDefaultTimeout`, `snapshot`, `snapshotRaw`, `title`, `url`, `waitForEvent`, `waitForFunction`, `waitForLoadState`, `waitForRequest`, `waitForResponse`, `waitForSelector`, `waitForTimeout`, `waitForURL`
- browser: `closeTab`, `currentTab`, `ensureRealTab`, `iframeTarget`, `listTabs`, `openOrReuseTab`, `switchTab`
- taskSpaces: `claim`, `complete`, `handOff`, `list`, `new`, `observe`, `requestControl`, `returnControl`, `switch`, `takeOver`, `useOrCreate`, `waitForAgentControl`
- site: `learnContext`, `runBrowserTool`, `runTool`, `skills`, `skillsForUrl`
- fetch: `browser`, `server`
- page.keyboard: `down`, `insertText`, `press`, `type`, `up`
- page.mouse: `click`, `dblclick`, `down`, `drag`, `move`, `up`, `wheel`
- locator: `allInnerTexts`, `allTextContents`, `blur`, `boundingBox`, `check`, `clear`, `click`, `count`, `dblclick`, `dispatchEvent`, `dragTo`, `evaluate`, `evaluateAll`, `fill`, `filter`, `first`, `focus`, `getAttribute`, `getByAltText`, `getByLabel`, `getByPlaceholder`, `getByRole`, `getByTestId`, `getByText`, `getByTitle`, `hover`, `innerHTML`, `innerText`, `inputValue`, `isChecked`, `isDisabled`, `isEditable`, `isEnabled`, `isHidden`, `isVisible`, `last`, `locator`, `nth`, `press`, `pressSequentially`, `screenshot`, `scrollIntoViewIfNeeded`, `selectOption`, `setChecked`, `setInputFiles`, `textContent`, `uncheck`, `waitFor`

## Machine-readable source

`automation-contract.json` preserves full JSON schemas, including enum, bounds, unions and MCP annotations.
