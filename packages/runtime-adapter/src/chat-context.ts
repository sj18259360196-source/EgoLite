import type {
  AIPageContent,
  AIPageNode,
  CollectionItem,
  EgoRuntime,
  EgoTab,
  SnapshotOptions,
} from "@ego-compat/protocol";

export interface ChatTabAttachment {
  id: string;
  type: "tab" | "tab-group";
  status: "success" | "error";
  title: string;
  content?: string;
  sourceUrl?: string;
  domain?: string;
  favicon?: string;
  tabCount?: number;
}

export interface ChatTabGroup {
  id: string;
  title?: string;
  color?: string;
  tabs: EgoTab[];
}

export interface ChatContextOptions {
  retryDelayMs?: number;
  signal?: AbortSignal;
  snapshot?: SnapshotOptions;
}

export interface ChatTextBlock {
  type: "text";
  content: string;
}

const SKIP_SUBTREES = new Set([1, 8, 9, 10, 11, 12]);

export function aiPageContentToMarkdown(page: AIPageContent): string {
  const output: string[] = [];
  const text = (node: AIPageNode): string =>
    node.textInfo?.textContent || node.children.map(text).filter(Boolean).join(" ");
  const visit = (node: AIPageNode): void => {
    if (SKIP_SUBTREES.has(node.attributeType)) return;
    const value = text(node);
    switch (node.attributeType) {
      case 6:
        if (value) output.push(`\n## ${value}\n`);
        return;
      case 4:
        if (value && node.label) output.push(`[${value}](${node.label})`);
        else if (value) output.push(value);
        return;
      case 7:
        if (node.label) output.push(`[Image: ${node.label}]`);
        return;
      case 18:
        if (value) output.push(`- ${value}`);
        return;
      case 5:
        if (value) output.push(`\n${value}\n`);
        return;
      case 14: {
        const cells = node.children.map(text).filter(Boolean);
        if (cells.length) output.push(cells.join(" | "));
        return;
      }
      default:
        if (node.textInfo?.textContent) output.push(node.textInfo.textContent);
        for (const child of node.children) visit(child);
    }
  };
  visit(page.rootNode);
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function fetchTabContent(
  runtime: EgoRuntime,
  tab: EgoTab | string,
  options: ChatContextOptions = {},
): Promise<{ textContent: string; title: string } | null> {
  const delay = options.retryDelayMs ?? 2_000;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    if (options.signal?.aborted) return null;
    try {
      const page = await runtime.getAIPageContent(tab, {
        includeActionMarks: false,
        includeStableLocator: false,
        ...options.snapshot,
      });
      if (!page) return null;
      const textContent = aiPageContentToMarkdown(page);
      if (textContent) return { textContent, title: page.title };
      if (attempt >= 2 || options.signal?.aborted) break;
      await abortableDelay(delay, options.signal);
    } catch {
      return null;
    }
  }
  return null;
}

export async function buildTabAttachment(
  runtime: EgoRuntime,
  tab: EgoTab,
  options: ChatContextOptions = {},
): Promise<ChatTabAttachment> {
  const result = await fetchTabContent(runtime, tab, options);
  return {
    id: `tab-${tab.id}`,
    type: "tab",
    status: result?.textContent ? "success" : "error",
    title: result?.title.trim() || tab.title,
    sourceUrl: tab.url,
    domain: domainOf(tab.url),
    ...(validFavicon(tab.faviconUrl) ? { favicon: tab.faviconUrl } : {}),
    ...(result?.textContent ? { content: result.textContent } : {}),
  };
}

export function tabAttachmentsToContentBlocks(
  attachments: ChatTabAttachment[],
): ChatTextBlock[] {
  return attachments.flatMap((attachment) => {
    if (!attachment.content) return [];
    if (attachment.type === "tab-group") {
      return [{ type: "text", content: attachment.content }];
    }
    return [{
      type: "text",
      content: `<context source="${escapeAttribute(attachment.sourceUrl || "")}" title="${escapeAttribute(attachment.title)}" domain="${escapeAttribute(attachment.domain || "")}" favicon="${escapeAttribute(attachment.favicon || "")}">\n${attachment.content}\n</context>`,
    }];
  });
}

export function collectionItemsToContentBlocks(items: CollectionItem[]): ChatTextBlock[] {
  return items.flatMap((item) => {
    if (!item.text.trim()) return [];
    return [{
      type: "text",
      content: `<context type="selected-text" source="${escapeAttribute(item.sourceUrl || "")}" title="${escapeAttribute(item.pageTitle || "")}">\n${item.text}\n</context>`,
    }];
  });
}

export async function buildTabGroupAttachment(
  runtime: EgoRuntime,
  group: ChatTabGroup,
  options: ChatContextOptions = {},
): Promise<ChatTabAttachment> {
  const pages = await Promise.all(group.tabs.map(async (tab) => ({
    tab,
    result: await fetchTabContent(runtime, tab, options),
  })));
  const contexts = pages
    .filter((page) => page.result?.textContent)
    .map((page) => wrapContext(page.tab, page.result!.textContent));
  return {
    id: `group-${group.id}`,
    type: "tab-group",
    status: contexts.length ? "success" : "error",
    title: group.title || "Tab Group",
    tabCount: group.tabs.length,
    ...(contexts.length
      ? {
          content: `<context-group title="${escapeAttribute(group.title || "Tab Group")}" color="${escapeAttribute(group.color || "")}" count="${group.tabs.length}">\n${contexts.join("\n")}\n</context-group>`,
        }
      : {}),
  };
}

function wrapContext(tab: EgoTab, content: string): string {
  return `<context source="${escapeAttribute(tab.url)}" title="${escapeAttribute(tab.title)}" domain="${escapeAttribute(domainOf(tab.url))}" favicon="${escapeAttribute(validFavicon(tab.faviconUrl) ? tab.faviconUrl! : "")}">\n${content}\n</context>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function validFavicon(value: string | undefined): value is string {
  return Boolean(value && (/^https?:\/\//.test(value) || value.startsWith("data:")));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
