import { cdp } from "../cdp-eval.js";
import { withScopedReferenceAction } from "../scoped-reference-context.js";
import { withHandle } from "./element-ops.js";
async function setInputFiles(selector, path) {
  return withScopedReferenceAction(selector, void 0, async () => {
    const files = Array.isArray(path) ? path : [path];
    await withHandle(selector, async ({ objectId, sessionId }) => {
      await cdp("DOM.setFileInputFiles", { files, objectId }, sessionId);
    });
  });
}
export {
  setInputFiles
};
