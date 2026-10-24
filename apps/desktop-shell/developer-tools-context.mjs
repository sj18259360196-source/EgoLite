// Executed against the selected DOM node in its own frame, including shadow DOM.
export function captureElementContext() {
  const element = this.nodeType === 1 ? this : this.nodeType === 9 ? this.documentElement : this.parentElement;
  if (!element?.isConnected) return null;
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const sensitive = /password|passwd|secret|token|api[-_]?key|authorization|nonce/i;
  const safeUrl = (value) => {
    try {
      const url = new view.URL(value, doc.baseURI);
      if (!["http:", "https:", "file:", "about:"].includes(url.protocol)) return `${url.protocol}[omitted]`;
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.set(key, "[omitted]");
      if (sensitive.test(url.hash)) url.hash = "";
      return url.href;
    } catch { return ""; }
  };
  const selectorWithinRoot = (node) => {
    const root = node.getRootNode();
    const parts = [];
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      if (current.id) {
        const id = `#${view.CSS.escape(current.id)}`;
        if (root.querySelectorAll(id).length === 1) return [id, ...parts].join(" > ");
      }
      for (const attr of ["data-testid", "data-test", "data-cy"]) {
        const value = current.getAttribute(attr);
        if (!value) continue;
        const candidate = `[${attr}="${view.CSS.escape(value)}"]`;
        if (root.querySelectorAll(candidate).length === 1) return [candidate, ...parts].join(" > ");
      }
      let part = view.CSS.escape(current.localName);
      const siblings = [...(current.parentNode?.children || [])].filter(peer => peer.localName === current.localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const selectorPath = [];
  for (let node = element; node; node = node.getRootNode().host) selectorPath.unshift(selectorWithinRoot(node));
  const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  let remaining = 250;
  let truncated = false;
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const serialize = (node, depth = 0) => {
    if (--remaining < 0 || depth > 12) { truncated = true; return ""; }
    if (node.nodeType === 3) return escape(String(node.textContent || "").slice(0, 1000));
    if (node.nodeType !== 1) return "";
    const tag = node.localName;
    const attrs = [...node.attributes].slice(0, 40).map(({ name, value }) => {
      if (sensitive.test(name) || name === "value" || name === "srcdoc" || name.startsWith("on") || name === "selected") return "";
      if (["src", "href", "action", "formaction"].includes(name)) value = safeUrl(value);
      return ` ${name}="${escape(value.slice(0, 1000))}"`;
    }).join("");
    if (voidTags.has(tag)) return `<${tag}${attrs}>`;
    const omitContent = ["script", "style", "textarea"].includes(tag) || node.isContentEditable;
    let body = omitContent ? "[omitted]" : "";
    if (!omitContent) {
      for (const child of node.childNodes) {
        if (remaining <= 0 || body.length > 12000) { truncated = true; break; }
        body += serialize(child, depth + 1);
      }
    }
    return `<${tag}${attrs}>${body}</${tag}>`;
  };
  const rawHtml = serialize(element);
  const style = view.getComputedStyle(element);
  const properties = [
    "display", "position", "box-sizing", "width", "height", "margin", "padding",
    "color", "background-color", "font-family", "font-size", "font-weight", "line-height",
    "border", "border-radius", "gap", "align-items", "justify-content",
    "grid-template-columns", "flex-direction", "overflow", "z-index",
  ];
  const rect = element.getBoundingClientRect();
  return {
    frameUrl: safeUrl(doc.URL),
    selector: selectorPath.at(-1),
    shadowHosts: selectorPath.slice(0, -1),
    tag: element.localName,
    html: rawHtml.slice(0, 12000),
    truncated: truncated || rawHtml.length > 12000,
    styles: Object.fromEntries(properties.map(name => [name, style.getPropertyValue(name)])),
    bounds: Object.fromEntries(["x", "y", "width", "height"].map(name => [name, Math.round(rect[name] * 100) / 100])),
    viewport: { width: view.innerWidth, height: view.innerHeight, devicePixelRatio: view.devicePixelRatio },
  };
}

// Keep version-specific DevTools frontend access in one place. The app pins Electron.
export const initializeFrontendExpression = `(async () => {
  const Elements = await import("./panels/elements/elements.js");
  const panel = Elements.ElementsPanel.ElementsPanel.instance();
  const split = panel.splitWidget;
  split.mainWidget().setMinimumSize(120, 140);
  split.sidebarWidget().setMinimumSize(120, 100);
  const resize = new ResizeObserver(() => {
    const height = split.element.clientHeight;
    if (!split.isVertical() && height > 0 && height - split.sidebarSize() < 140) {
      split.setSidebarSize(Math.max(100, height * 0.45));
    }
  });
  resize.observe(split.element);
  return true;
})()`;

export const selectedElementExpression = `(async () => {
  const SDK = await import("./core/sdk/sdk.js");
  const UI = await import("./ui/legacy/legacy.js");
  const node = UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode);
  if (!node) return null;
  const object = await node.resolveToObject("ego-element-context");
  if (!object) return null;
  try { return await object.callFunctionJSON(${captureElementContext.toString()}); }
  finally { object.release(); }
})()`;

export function contextMenuInspectionPoint(point, bounds, shellZoom = 1, pageZoom = 1) {
  if (!bounds || ![point?.x, point?.y, bounds.x, bounds.y, shellZoom, pageZoom].every(Number.isFinite)
    || shellZoom <= 0 || pageZoom <= 0) throw new Error("无法读取网页位置");
  // Guest context-menu coordinates are embedder DIP, while CDP hit testing uses page CSS pixels.
  return { x: (point.x - bounds.x * shellZoom) / pageZoom, y: (point.y - bounds.y * shellZoom) / pageZoom };
}

export function pointWithinQuad(point, quad) {
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("无法读取框架位置");
  const ax = quad[2] - quad[0], ay = quad[3] - quad[1];
  const bx = quad[6] - quad[0], by = quad[7] - quad[1];
  const dx = point.x - quad[0], dy = point.y - quad[1];
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) < 0.001) throw new Error("框架不可见");
  return { x: (dx * by - dy * bx) / determinant, y: (dy * ax - dx * ay) / determinant };
}

export async function resolveInspectionPoint(sendCommand, point) {
  const hit = await sendCommand("DOM.getNodeForLocation", point);
  if (!hit.backendNodeId) return hit;
  const { node } = await sendCommand("DOM.describeNode", { backendNodeId: hit.backendNodeId });
  if (node.frameId && ["IFRAME", "FRAME"].includes(node.nodeName)) {
    const { model } = await sendCommand("DOM.getBoxModel", { backendNodeId: hit.backendNodeId });
    return { ...hit, childFrameId: node.frameId, framePoint: pointWithinQuad(point, model.content) };
  }
  return hit;
}

export function inspectNodeExpression(hit) {
  return `(async () => {
    const SDK = await import("./core/sdk/sdk.js");
    const UI = await import("./ui/legacy/legacy.js");
    const Common = await import("./core/common/common.js");
    await UI.InspectorView.InspectorView.instance().showPanel("elements");
    const manager = SDK.TargetManager.TargetManager.instance();
    let hit = ${JSON.stringify({ backendNodeId: hit.backendNodeId, frameId: hit.frameId, childFrameId: hit.childFrameId, framePoint: hit.framePoint })};
    const targetForFrame = async frameId => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const models = manager.models(SDK.ResourceTreeModel.ResourceTreeModel);
        const model = models.find(model => model.mainFrame?.id === frameId)
          || models.find(model => model.frameForId(frameId));
        if (model) return model.target();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Inspected frame is unavailable");
    };
    let target = await targetForFrame(hit.frameId);
    for (let depth = 0; hit.childFrameId && hit.framePoint && depth < 12; depth++) {
      target = await targetForFrame(hit.childFrameId);
      await target.model(SDK.DOMModel.DOMModel).requestDocument();
      const metrics = await target.pageAgent().invoke_getLayoutMetrics();
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
      const point = { x: Math.round(hit.framePoint.x * viewport.clientWidth), y: Math.round(hit.framePoint.y * viewport.clientHeight) };
      hit = await target.domAgent().invoke_getNodeForLocation({ ...point, includeUserAgentShadowDOM: true });
      if (hit.getError() || !hit.backendNodeId) throw new Error(hit.getError() || "No element at this position");
      const described = await target.domAgent().invoke_describeNode({ backendNodeId: hit.backendNodeId });
      if (described.node?.frameId && ["IFRAME", "FRAME"].includes(described.node.nodeName)) {
        const box = await target.domAgent().invoke_getBoxModel({ backendNodeId: hit.backendNodeId });
        hit.childFrameId = described.node.frameId;
        hit.framePoint = (${pointWithinQuad.toString()})(point, box.model.content);
      }
    }
    await target.model(SDK.DOMModel.DOMModel).requestDocument();
    await Common.Revealer.reveal(new SDK.DOMModel.DeferredDOMNode(target, hit.backendNodeId));
    return true;
  })()`;
}

export function formatElementContext(context) {
  if (!context?.selector || typeof context.html !== "string") throw new Error("请先在开发者工具中选中一个元素");
  const fence = "`".repeat(Math.max(3, ...[...context.html.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return [
    "## 页面元素",
    "",
    `页面 ${context.frameUrl}`,
    ...(context.shadowHosts?.length ? [`Shadow DOM 宿主 ${context.shadowHosts.join(" → ")}`] : []),
    `CSS 选择器 ${context.selector}`,
    `位置 ${JSON.stringify(context.bounds)}`,
    `视口 ${JSON.stringify(context.viewport)}`,
    "",
    "### HTML",
    `${fence}html`,
    context.html,
    fence,
    ...(context.truncated ? ["HTML 已截断。"] : []),
    "",
    "### 计算样式",
    "```css",
    ...Object.entries(context.styles || {}).map(([name, value]) => `${name}: ${value};`),
    "```",
    "",
    "以上为当前渲染结果，尚未定位到项目源文件。表单值、脚本内容和常见敏感属性已省略，请在发送前检查其余内容。",
  ].join("\n");
}
