import assert from "node:assert/strict";
import test from "node:test";

import type { AIPageContent, EgoRuntime, EgoTab } from "@ego-compat/protocol";

import {
  aiPageContentToMarkdown,
  buildTabAttachment,
  buildTabGroupAttachment,
  collectionItemsToContentBlocks,
  fetchTabContent,
  tabAttachmentsToContentBlocks,
} from "./chat-context.ts";

const tab: EgoTab = {
  id: "target-1",
  targetId: "target-1",
  taskId: "task-1",
  title: "Docs & Help",
  url: "https://www.example.test/docs?a=1&b=2",
  active: true,
  faviconUrl: "https://example.test/favicon.ico",
};

const page: AIPageContent = {
  title: "Docs & Help",
  url: tab.url,
  content: "unused snapshot text",
  refs: [],
  rootNode: {
    attributeType: 0,
    children: [
      { attributeType: 6, textInfo: { textContent: "Guide" }, children: [] },
      {
        attributeType: 5,
        children: [
          { attributeType: 3, textInfo: { textContent: "Read the docs" }, children: [] },
        ],
      },
      {
        attributeType: 4,
        label: "https://example.test/start",
        textInfo: { textContent: "Start" },
        children: [],
      },
      {
        attributeType: 14,
        children: [
          { attributeType: 15, textInfo: { textContent: "A" }, children: [] },
          { attributeType: 15, textInfo: { textContent: "B" }, children: [] },
        ],
      },
      {
        attributeType: 12,
        textInfo: { textContent: "Control text must be skipped" },
        children: [],
      },
    ],
  },
};

test("AI page tree serializes with the recovered Ego markdown rules", () => {
  const markdown = aiPageContentToMarkdown(page);
  assert.match(markdown, /## Guide/);
  assert.match(markdown, /Read the docs/);
  assert.match(markdown, /\[Start\]\(https:\/\/example\.test\/start\)/);
  assert.match(markdown, /A \| B/);
  assert.doesNotMatch(markdown, /Control text/);
});

test("saved selections become original selected-text context blocks", () => {
  const block = collectionItemsToContentBlocks([{
    id: "saved-1",
    text: "Important <finding>",
    sourceUrl: "https://example.test/report?a=1&b=2",
    pageTitle: "Report & notes",
    createdAt: "2026-08-13T00:00:00.000Z",
  }])[0];
  assert.match(block?.content ?? "", /type="selected-text"/);
  assert.match(block?.content ?? "", /source="https:\/\/example\.test\/report\?a=1&amp;b=2"/);
  assert.match(block?.content ?? "", /title="Report &amp; notes"/);
  assert.match(block?.content ?? "", /Important <finding>/);
});

test("empty AI content retries three times before failing", async () => {
  let calls = 0;
  const runtime = runtimeWith(async () => {
    calls += 1;
    return { ...page, rootNode: { attributeType: 0, children: [] } };
  });

  assert.equal(await fetchTabContent(runtime, tab, { retryDelayMs: 0 }), null);
  assert.equal(calls, 3);
});

test("tab and tab-group attachments match Ego context wrappers", async () => {
  const runtime = runtimeWith(async () => page);
  const single = await buildTabAttachment(runtime, tab, { retryDelayMs: 0 });
  const group = await buildTabGroupAttachment(runtime, {
    id: "research",
    title: "Research <set>",
    color: "blue",
    tabs: [tab],
  }, { retryDelayMs: 0 });

  assert.equal(single.status, "success");
  assert.doesNotMatch(single.content ?? "", /<context/);
  const blocks = tabAttachmentsToContentBlocks([single, group]);
  assert.match(blocks[0]?.content ?? "", /<context source=/);
  assert.match(blocks[0]?.content ?? "", /Docs &amp; Help/);
  assert.match(blocks[1]?.content ?? "", /<context-group title="Research &lt;set&gt;"/);
  assert.match(blocks[1]?.content ?? "", /count="1"/);
});

function runtimeWith(
  getAIPageContent: EgoRuntime["getAIPageContent"],
): EgoRuntime {
  return {
    getAIPageContent,
  } as unknown as EgoRuntime;
}
