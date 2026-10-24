import assert from "node:assert/strict";
import test from "node:test";
import { RelevanceFilter } from "./relevance.ts";
import { extractSchema, relevanceSchema } from "./schema.ts";

const options = (extra = {}) => relevanceSchema.parse({ query: "Browser automation", fields: ["title"], ...extra });

test("relevance is opt-in with bounded batch, candidate and text limits", () => {
  assert.equal(extractSchema.parse({ selector: "tr", fields: { title: {} } }).relevance, undefined);
  assert.throws(() => options({ batchSize: 41 }));
  assert.throws(() => options({ maxCandidates: 1001 }));
  assert.throws(() => options({ maxDecisions: 0 }));
  assert.throws(() => options({ query: " " }));
  assert.throws(() => options({ fields: ["title", "title"] }));
  assert.throws(() => extractSchema.parse({ selector: "tr", fields: { title: {} }, relevance: options({ fields: ["password"] }) }));
});

test("independent judgments preserve order, unknown rows and provenance", () => {
  const filter = new RelevanceFilter(options());
  const rows = [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }];
  filter.add(rows.slice(0, 2), 0);
  filter.add(rows.slice(2), 1);
  const [batch] = [...filter.batches(rows, 0)];
  assert.equal(filter.accept(batch!, {
    r0: { type: "noul", noul: 0.2 }, r1: { type: "noul", noul: 0.8 },
    r2: { type: "noul", noul: 0.5 }, r3: { type: "noul", noul: 0.99 },
  }), true);
  const result = filter.result(rows);
  assert.deepEqual(result.rows, rows.slice(1));
  assert.deepEqual(result.relevance.rowIndices, [1, 2, 3]);
  assert.deepEqual(result.relevance.judgments.map(item => item.sourceIndex), [0, 0, 1, 1]);
  assert.equal(result.relevance.complete, true);
  assert.equal(result.relevance.unknownRows, 1);
  assert.equal(result.relevance.excludedRows, 1);
});

test("only named fields are sent and oversized or unavailable text is never excluded", () => {
  const filter = new RelevanceFilter(options({ maxTextChars: 100, maxCandidates: 4 }));
  const rows = [
    { title: "Good", secret: "PRIVATE_VALUE" }, { title: null },
    { title: "x".repeat(101) }, { title: "[redacted]" }, { title: "Beyond budget" },
  ];
  filter.add(rows, 0);
  const batches = [...filter.batches(rows, 0)];
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  const request = filter.request(batches[0]!);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_VALUE|secret/);
  assert.match(request.state.scope, /untrusted/);
  assert.deepEqual(filter.judgments.map(item => item.reason), ["not_evaluated", "missing_text", "text_limit", "redacted_text", "candidate_limit"]);
  assert.deepEqual(filter.result(rows).rows, rows);
  assert.equal(filter.result(rows).relevance.complete, false);
});

test("invalid batch answers are rejected atomically", () => {
  for (const invalid of [NaN, Infinity, -0.1, 1.1, undefined]) {
    const filter = new RelevanceFilter(options());
    const rows = [{ title: "A" }, { title: "B" }];
    filter.add(rows, 0);
    const [batch] = [...filter.batches(rows, 0)];
    assert.equal(filter.accept(batch!, { r0: { type: "noul", noul: 0 }, r1: { type: "noul", noul: invalid } } as any), false);
    assert.deepEqual(filter.result(rows).rows, rows);
    assert.ok(filter.judgments.every(item => item.probability === null));
  }
});

test("batch size and escaped UTF-8 request bytes stay bounded", () => {
  const filter = new RelevanceFilter(options({ batchSize: 40, maxTextChars: 2000, query: "\u0001".repeat(4000) }));
  const rows = Array.from({ length: 85 }, () => ({ title: "\u0001".repeat(2000) }));
  filter.add(rows, 0);
  const batches = [...filter.batches(rows, 0)];
  assert.equal(batches.flat().length, 85);
  for (const batch of batches) {
    assert.ok(batch.length <= 40);
    assert.ok(Buffer.byteLength(JSON.stringify(filter.request(batch))) <= 120000);
    assert.equal(Object.keys(filter.request(batch).questions).length, batch.length);
  }
});
