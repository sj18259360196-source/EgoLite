export function parseLibraryJson(content) {
  const parsed = JSON.parse(content);
  const source = Array.isArray(parsed) ? parsed : parsed?.collections;
  if (!Array.isArray(source)) throw new Error("JSON 文件不包含 collections 数组");
  if (source.length > 10_000) throw new Error("单次最多导入 10000 条收藏");
  const folders = Array.isArray(parsed.folders) ? parsed.folders.filter(folder => folder && !folder.deletedAt) : [];
  const entries = source.filter(item => item && typeof item === "object" && !item.deletedAt).map(item => ({
    text: String(item.text || item.pageTitle || item.sourceUrl || "").trim(),
    ...Object.fromEntries(["sourceUrl", "pageTitle", "faviconUrl", "group", "createdAt"].filter(key => typeof item[key] === "string").map(key => [key, item[key]])),
    ...(item.kind === "bookmark" || item.kind === "excerpt" ? { kind: item.kind } : {}),
    ...(folders.length && typeof item.folderId === "string" ? { folderId: item.folderId } : {}),
    ...(Number.isFinite(item.order) ? { order: item.order } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags.map(String) } : {}),
  })).filter(item => item.text);
  return { entries, folders };
}

// This pure function runs in the renderer, where the browser supplies an HTML parser.
export function parseBookmarksDocument(content) {
  const document = new DOMParser().parseFromString(content, "text/html");
  const entries = [];
  const folders = [];
  let sequence = 0;
  function visit(list, parentId, depth) {
    if (depth > 64) throw new Error("收藏目录层级过深");
    let order = 0;
    for (const node of list.children) {
      if (node.tagName !== "DT") continue;
      const heading = [...node.children].find(child => child.tagName === "H3");
      const anchor = [...node.children].find(child => child.tagName === "A");
      if (heading) {
        const marker = heading.getAttribute("data-ego-root");
        const id = marker === "bar" || marker === "other" ? marker :
          heading.getAttribute("PERSONAL_TOOLBAR_FOLDER") === "true" ? "bar" : `import-${++sequence}`;
        if (!folders.some(folder => folder.id === id)) folders.push({
          id, name: heading.textContent.trim() || "未命名文件夹",
          parentId: id === "bar" || id === "other" ? null : parentId, order: order++,
        });
        const nested = [...node.children].find(child => child.tagName === "DL") ||
          (node.nextElementSibling?.tagName === "DL" ? node.nextElementSibling : null);
        if (nested) visit(nested, id, depth + 1);
      } else if (anchor) {
        const url = anchor.getAttribute("href") || "";
        let parsed;
        try { parsed = new URL(url); } catch { continue; }
        if (!["http:", "https:", "file:"].includes(parsed.protocol)) continue;
        const title = anchor.textContent.trim() || parsed.href;
        const seconds = Number(anchor.getAttribute("ADD_DATE"));
        const date = seconds > 0 ? new Date(seconds * 1000) : null;
        entries.push({
          text: title, pageTitle: title, sourceUrl: parsed.href, kind: "bookmark",
          folderId: parentId, order: order++,
          ...(date && !Number.isNaN(date.getTime()) ? { createdAt: date.toISOString() } : {}),
        });
      }
      if (entries.length + folders.length > 10_000) throw new Error("单次最多导入 10000 项");
    }
  }
  const root = document.querySelector("dl");
  if (root) visit(root, "other", 0);
  return { entries, folders };
}

export function libraryToBookmarksHtml(items, folders) {
  const escape = value => String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Ego Collections</TITLE>", "<H1>Ego Collections</H1>", "<DL><p>"];
  const visited = new Set();
  function visit(parentId, depth) {
    const children = [
      ...folders.filter(folder => !folder.deletedAt && folder.parentId === parentId),
      ...items.filter(item => !item.deletedAt && item.sourceUrl && (item.folderId || "other") === parentId),
    ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const entry of children) {
      const indent = "    ".repeat(depth);
      if ("parentId" in entry) {
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
        const root = ["bar", "other"].includes(entry.id) ? ` data-ego-root="${entry.id}"${entry.id === "bar" ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ""}` : "";
        lines.push(`${indent}<DT><H3${root}>${escape(entry.name)}</H3>`, `${indent}<DL><p>`);
        visit(entry.id, depth + 1);
        lines.push(`${indent}</DL><p>`);
      } else {
        const seconds = Math.max(0, Math.floor(Date.parse(entry.createdAt) / 1000)) || 0;
        lines.push(`${indent}<DT><A HREF="${escape(entry.sourceUrl)}" ADD_DATE="${seconds}">${escape(entry.pageTitle || entry.text || entry.sourceUrl)}</A>`);
      }
    }
  }
  visit(null, 1);
  lines.push("</DL><p>", "");
  return lines.join("\n");
}
