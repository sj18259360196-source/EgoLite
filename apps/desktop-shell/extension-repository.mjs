const bundledRepository = [
  {
    id: "ego-companion",
    name: "Ego Windows Companion",
    version: "bundled",
    description: "让 EgoLite 复用 Edge 或 Chrome 中明确授权的标签页。",
    source: "companion",
    permissions: ["nativeMessaging", "tabs", "activeTab"],
    category: "官方",
  },
];

export function bundledExtensionRepository() {
  return bundledRepository.map((item) => ({ ...item, permissions: [...item.permissions] }));
}

export function normalizeExtensionRepository(items, installedIds = new Set()) {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string") return [];
    const source = item.source === "companion" ? "companion" : typeof item.url === "string" ? "url" : "";
    if (!source) return [];
    return [{
      id: item.id.slice(0, 120),
      name: item.name.slice(0, 200),
      version: String(item.version || "未知").slice(0, 80),
      description: String(item.description || "").slice(0, 500),
      category: String(item.category || "其他").slice(0, 60),
      source,
      ...(source === "url" ? { url: item.url.slice(0, 2_000) } : {}),
      permissions: Array.isArray(item.permissions) ? item.permissions.filter((value) => typeof value === "string").slice(0, 40) : [],
      installed: installedIds.has(item.id),
    }];
  });
}
