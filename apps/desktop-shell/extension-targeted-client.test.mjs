import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installTargetedExtensionClient } from './extension-targeted-client.mjs';

function setup() {
  const calls = [];
  let dispatch;
  const chrome = {
    runtime: { id: 'eeagobfjdenkkddmbclomhiblgggliao', getManifest: () => ({ name: 'Violentmonkey' }), sendMessage: (command, callback) => callback([{ command }, null]) },
    tabs: { executeScript() {} }, storage: {}, extension: {},
  };
  const context = { chrome, navigator: {}, location: { pathname: '/confirm/index.html' }, addEventListener() {}, console,
    egoExtensionHost: { onEvent(fn) { dispatch = fn; }, call(method, args) { calls.push({ method, args }); return Promise.resolve({ value: true }); } },
  };
  runInNewContext(`(${installTargetedExtensionClient})()`, context);
  return { context, calls, dispatch };
}

test('VM installer and settings worker messages reach the native background and unwrap replies', () => {
  const { context } = setup();
  const worker = context.navigator.serviceWorker;
  let received;
  worker.onmessage = event => { received = event.data; };
  // VM can replace chrome methods during bootstrap; keep the original callback API.
  context.chrome.runtime.sendMessage = () => { throw Error('wrapped API must not be used'); };
  worker.controller.postMessage({ id: 7, msg: JSON.stringify({ cmd: 'SetOptions', data: { autoReload: true } }) });
  assert.equal(received.id, 7);
  assert.equal(received.res.command.cmd, 'SetOptions');
  assert.equal(received.res.command.data.autoReload, true);
  assert.doesNotThrow(() => worker.controller.postMessage({ id: 7, res: true }));
});

test('network listeners retain independent filters and can be removed individually', () => {
  const { context, calls, dispatch } = setup();
  const request = context.chrome.webRequest.onBeforeRequest;
  const seen = [];
  const popup = () => seen.push('popup');
  const install = () => seen.push('install');
  request.addListener(popup, { urls: ['chrome-extension://id/popup/index.html'], types: ['main_frame'] });
  request.addListener(install, { urls: ['*://*/*.user.js'], types: ['main_frame'] });
  assert.equal(calls.at(-1).args[1].length, 2);
  dispatch('webRequest.onBeforeRequest', [{ url: 'https://example.test/a.user.js', type: 'main_frame', method: 'GET' }]);
  assert.deepEqual(seen, ['install']);
  request.removeListener(install);
  assert.equal(request.hasListener(popup), true);
  assert.equal(calls.at(-1).args[1].length, 1);
});
