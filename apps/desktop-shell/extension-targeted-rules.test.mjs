import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTargetedHeaders, updateTargetedRules } from './extension-targeted-rules.mjs';

const rule = { id: 1, condition: { tabIds: [-1], urlFilter: '|https://example.test/data|' }, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Adapter', operation: 'set', value: 'ok' }] } };

test('targeted header rules affect only the exact request URL', () => {
  const rules = updateTargetedRules(new Map(), { addRules: [rule] });
  assert.deepEqual(applyTargetedHeaders(rules, 'https://example.test/data', { Accept: '*/*' }, 'requestHeaders'), { Accept: '*/*', 'X-Adapter': 'ok' });
  assert.deepEqual(applyTargetedHeaders(rules, 'https://example.test/other', { Accept: '*/*' }, 'requestHeaders'), { Accept: '*/*' });
  assert.equal(updateTargetedRules(rules, { removeRuleIds: [1] }).size, 0);
});

test('unsupported or malformed rules are rejected atomically', () => {
  const rules = updateTargetedRules(new Map(), { addRules: [rule] });
  for (const invalid of [
    { ...rule, id: 2, condition: { ...rule.condition, tabIds: [7] } },
    { ...rule, id: 2, condition: { ...rule.condition, urlFilter: '*example*' } },
    { ...rule, id: 2, action: { type: 'block' } },
    { ...rule, id: 2, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Test', operation: 'set', value: 'bad\r\nvalue' }] } },
  ]) {
    assert.throws(() => updateTargetedRules(rules, { removeRuleIds: [1], addRules: [invalid] }));
    assert.equal(rules.size, 1);
  }
});

test('response header removal is case insensitive and append retains previous values', () => {
  const rules = updateTargetedRules(new Map(), { addRules: [{ ...rule, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'set-cookie', operation: 'remove' }, { header: 'x-test', operation: 'append', value: 'two' }] } }] });
  assert.deepEqual(applyTargetedHeaders(rules, 'https://example.test/data', { 'Set-Cookie': ['secret=1'], 'X-Test': ['one'] }, 'responseHeaders'), { 'X-Test': ['one', 'two'] });
});
