import test from 'node:test';
import assert from 'node:assert/strict';
import { popupOpenPolicy, extensionOpenPolicy } from './tab-open-policy.mjs';

test('visible-page popups display unless explicitly opened in the background', () => {
  for (const disposition of ['foreground-tab', 'new-window', 'default']) {
    assert.deepEqual(popupOpenPolicy({ sourceVisible: true, disposition }), { active: true, visual: true });
  }
  assert.deepEqual(popupOpenPolicy({ sourceVisible: true, disposition: 'background-tab' }), { active: false, visual: false });
});
test('Agent and background page popups never select the visible page', () => {
  assert.deepEqual(popupOpenPolicy({ sourceVisible: false, disposition: 'foreground-tab' }), { active: true, visual: false });
});
test('extension active:false preserves the visible selection', () => {
  assert.deepEqual(extensionOpenPolicy(), { active: true, visual: true });
  assert.deepEqual(extensionOpenPolicy({ active: false }), { active: false, visual: false });
});
