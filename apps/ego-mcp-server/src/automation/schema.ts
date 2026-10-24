import { z } from "zod";

const target = z.string().min(1).max(2000);
const taskReference = z.union([z.string().min(1).max(200), z.number().int().positive()]).optional();
export const checkSchema = z.object({
  kind: z.enum(["url_contains", "url_path_contains", "title_contains", "visible", "hidden", "text_contains", "value_equals", "checked", "count_equals", "filter_value"]),
  target: target.optional(),
  name: z.string().max(200).optional(),
  value: z.union([z.string().max(20000), z.number().int().min(0), z.boolean()]).optional(),
}).strict().superRefine((check, context) => {
  if (check.kind === "count_equals" && typeof check.value !== "number") context.addIssue({ code: "custom", message: "Count checks require a number" });
  if (check.kind === "checked" && check.value !== undefined && typeof check.value !== "boolean") context.addIssue({ code: "custom", message: "Checked state requires a boolean" });
  if (!["visible", "hidden", "checked"].includes(check.kind) && check.value === undefined) {
    context.addIssue({ code: "custom", message: "This completion check requires a value" });
  }
  if (!["url_contains", "url_path_contains", "title_contains", "filter_value"].includes(check.kind) && !check.target) {
    context.addIssue({ code: "custom", message: "This completion check requires a CSS target" });
  }
  if (check.kind === "filter_value" && !check.target && !check.name) context.addIssue({ code: "custom", message: "Filter check requires a target or name" });
  if (check.target?.startsWith("@")) context.addIssue({ code: "custom", message: "Completion checks use CSS, not transient refs" });
  if (typeof check.value === "string" && !check.value.length && ["url_contains", "url_path_contains", "title_contains", "text_contains"].includes(check.kind)) {
    context.addIssue({ code: "custom", message: "Empty substring checks cannot verify completion" });
  }
});
export const actionSchema = z.object({
  action: z.enum(["click", "fill", "select", "check", "uncheck", "press", "hover", "scroll", "navigate", "wait", "upload"]),
  target: target.optional(),
  targetHint: z.string().min(1).max(500).optional(),
  valueKey: z.string().min(1).max(100).optional(),
  value: z.string().max(20000).optional(),
  deltaY: z.number().min(-10000).max(10000).optional(),
  waitFor: checkSchema.optional(),
  consequential: z.boolean().optional(),
}).strict();
export const runSchema = z.object({
  task: taskReference,
  goal: z.string().min(1).max(4000),
  values: z.record(z.string().min(1).max(100), z.string().max(20000)).refine(value => Object.keys(value).length <= 50, "At most 50 supplied values").default({}),
  steps: z.array(actionSchema).max(100).default([]),
  success: z.object({ all: z.array(checkSchema).min(1).max(20) }).strict(),
  allowedOrigins: z.array(z.string().url()).max(30).optional(),
  authorizedActions: z.array(z.enum(["submit", "delete", "purchase", "send", "upload"])).max(5).default([]),
  mode: z.enum(["auto", "direct", "repair"]).default("auto"),
  budget: z.object({
    maxActions: z.number().int().min(1).max(100).default(24),
    maxDecisions: z.number().int().min(1).max(60).default(18),
    timeoutMs: z.number().int().min(1000).max(120000).default(45000),
  }).default({ maxActions: 24, maxDecisions: 18, timeoutMs: 45000 }),
}).strict();
export const relevanceSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  fields: z.array(z.string().min(1).max(100)).min(1).max(8).refine(fields => new Set(fields).size === fields.length, "Relevance fields must be unique"),
  batchSize: z.number().int().min(1).max(40).default(20),
  maxCandidates: z.number().int().min(1).max(1000).default(200),
  maxDecisions: z.number().int().min(1).max(60).default(10),
  maxTextChars: z.number().int().min(100).max(2000).default(1000),
}).strict();
export const extractSchema = z.object({
  task: taskReference,
  selector: z.string().min(1).max(2000),
  fields: z.record(z.string().min(1).max(100), z.object({
    selector: z.string().max(2000).default(""),
    attribute: z.enum(["text", "href", "src", "value", "datetime", "title"]).default("text"),
  }).strict()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 30),
  maxRows: z.number().int().min(1).max(5000).default(500),
  next: z.string().max(2000).optional(),
  maxPages: z.number().int().min(1).max(30).default(1),
  timeoutMs: z.number().int().min(1000).max(120000).default(45000),
  relevance: relevanceSchema.optional(),
}).strict().superRefine((input, context) => {
  for (const field of input.relevance?.fields || []) {
    if (!Object.hasOwn(input.fields, field)) context.addIssue({ code: "custom", path: ["relevance", "fields"], message: "Relevance fields must be extracted fields" });
  }
});
export type RunInput = z.infer<typeof runSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Check = z.infer<typeof checkSchema>;
export type ExtractInput = z.infer<typeof extractSchema>;
