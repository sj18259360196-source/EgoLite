import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CosRuntime } from '../apps/desktop-shell/workspace-packs/cos-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const parent = join(root, '.tmp/codex/cos-business-smoke');
await mkdir(parent, { recursive: true });
const work = await mkdtemp(join(parent, 'run-'));
const directory = resolve(process.argv[2] || join(root, 'release/win-unpacked/resources/components/cos'));
const state = join(work, 'state');
const sessionId = '2026-10-24-11223344';
const sessionDirectory = join(state, 'sessions', sessionId);
await mkdir(sessionDirectory, { recursive: true });
const now = Date.now();
await writeFile(join(sessionDirectory, 'meta.json'), JSON.stringify({
  id: sessionId, title: 'Ego acceptance fixture', conversationId: '11111111-1111-4111-8111-111111111111',
  chatIds: ['11111111-1111-4111-8111-111111111111'], startedAt: now, updatedAt: now, endedAt: null,
  events: 0, timelineTurns: {}, nativeQuestion: null, requestTurns: {}, userMessages: 0, toolCalls: 0,
  lastToolCallAt: null, lastToolActivity: null, lastAssistantFinalAt: null, lastTurnEndAt: null,
  lastFinishReportAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
  estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
  lastCommittedResumeHandoffId: null, lastTurnOutcome: null, activeTurnId: null, finishTurn: null, agents: [], origin: null,
}));
await writeFile(join(sessionDirectory, 'events.jsonl'), '');
let picker = { canceled: true };
let prompts = 0;
const runtime = new CosRuntime({ directory, dataDirectory: state, onHostRequest: async (method, options) => {
  assert.equal(method, 'dialog.save');
  assert.ok(options.defaultPath);
  prompts++;
  return picker;
} });
const evidence = { checkedAt: new Date().toISOString(), directory, passed: false, controlledPicker: true };
const invoke = async (channel, payload) => {
  const response = await runtime.invoke(channel, payload);
  assert.equal(response.ok, true, `${channel}: ${response.error}`);
  return response.data;
};
try {
  await runtime.start();
  const initial = await invoke('state:get');
  const codePath = join(work, 'answer.ts');
  picker = { canceled: false, filePath: codePath };
  const code = 'const answer = 42;\n// 中文 UTF-8\n';
  assert.equal((await invoke('code:save', { text: code, name: 'answer.ts' })).done, 'saved');
  assert.equal(await readFile(codePath, 'utf8'), code);
  assert.equal((await invoke('code:save', { text: 'updated\n', name: 'answer.ts' })).done, 'saved');
  assert.equal(await readFile(codePath, 'utf8'), 'updated\n');
  picker = { canceled: true };
  assert.equal((await invoke('code:save', { text: 'must not overwrite', name: 'answer.ts' })).done, 'cancelled');
  assert.equal(await readFile(codePath, 'utf8'), 'updated\n');
  const beforeInvalid = prompts;
  assert.equal((await runtime.invoke('code:save', { text: 'bad', name: '../escape.ts' })).ok, false);
  assert.equal(prompts, beforeInvalid);
  evidence.codeSaveOverwriteCancelAndValidation = true;

  const csvPath = join(work, 'usage.csv');
  picker = { canceled: false, filePath: csvPath };
  assert.equal((await invoke('usage:export', { divisor: 4000 })).saved, true);
  const csv = await readFile(csvPath, 'utf8');
  assert.ok(csv.includes(',') && csv.split(/\r?\n/).length > 2);
  picker = { canceled: true };
  assert.equal((await invoke('usage:export', { divisor: 4000 })).saved, false);
  assert.equal(await readFile(csvPath, 'utf8'), csv);
  const beforeBadUsage = prompts;
  assert.equal((await runtime.invoke('usage:export', { divisor: 0 })).ok, false);
  assert.equal(prompts, beforeBadUsage);
  assert.equal((await readdir(work)).some(file => file.endsWith('.tmp')), false);
  evidence.csvExportAndCancelPreserveExistingFile = true;

  const mark = { id: sessionId, messageId: '22222222-2222-4222-8222-222222222222', excerpt: 'Ego bookmark fixture', messageTime: now, on: true };
  assert.equal((await invoke('sessions:bookmark', mark)).length, 1);
  const config = initial.config;
  const fields = ['capabilities', 'readOnly', 'commandAllowlist', 'tunnel', 'ui', 'sessions', 'compaction', 'multiAgent', 'goal', 'mcp', 'controlApi'];
  const base = Object.fromEntries(fields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const theme = config.ui.theme === 'dark' ? 'light' : 'dark';
  await invoke('settings:save', { base, patch: { ...base, ui: { ...base.ui, theme } } });
  await runtime.stop();
  await runtime.start();
  assert.equal((await invoke('state:get')).config.ui.theme, theme);
  assert.equal((await invoke('sessions:bookmarks', { id: sessionId }))[0].excerpt, mark.excerpt);
  const search = await invoke('sessions:search', { query: 'Ego acceptance' });
  assert.ok(search.results.some(result => result.id === sessionId || result.session?.id === sessionId), JSON.stringify(search));
  assert.equal((await invoke('sessions:bookmark', { ...mark, on: false })).length, 0);
  evidence.bookmarkAndSettingsSurviveRestartAndSearchFindsSession = true;
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  await runtime.stop();
  evidence.runtimeStopped = runtime.state === 'stopped';
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  evidence.testDataDirectoryRemoved = true;
  await writeFile(join(root, 'docs/cos-workspace-pack/evidence/cos11-business-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
