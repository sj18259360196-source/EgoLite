import type { AppState } from '../shared/types.js';
import { currentLanguage, ui } from './i18n.js';

declare global {
  interface Window { egoHost?: { name: string; protocol: number }; }
}

export const isEgoHosted = window.egoHost?.name === 'EgoLite';
const text = (english: string, chinese: string): string =>
  currentLanguage().startsWith('zh') ? chinese : english;

export function initEgoHostedUi(): void {
  if (!isEgoHosted) return;
  const style = document.createElement('style');
  style.id = 'ego-hosted-ui';
  // Keep upstream nodes and listeners intact while removing standalone-only controls.
  style.textContent = `
    #bridgeFolder, #bridgeDownload, #bridgeUnpair, #extensionPath,
    #startAtLoginRow, label:has(#minimizeToTray), label:has(#chatBrowser), #updateExtension,
    [data-step="browser"] .browser-setup > :not(#egoBrowserSetup),
    label:has(#browserBridgePort), #updateGet, #updateInstall, #installUpdate,
    [data-step="browser"] .step-body > ol,
    [data-step="browser"] .step-body > p { display: none !important; }
  `;
  document.head.append(style);
  const setup = document.querySelector('[data-step="browser"] .browser-setup');
  if (setup && !document.getElementById('egoBrowserSetup')) {
    const panel = document.createElement('section');
    panel.id = 'egoBrowserSetup';
    const heading = document.createElement('h3');
    ui(heading, 'textContent', () => text('Ego browser', 'Ego 浏览器'));
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-solid';
    open.innerHTML = '<i class="ico ph ph-arrow-square-out" aria-hidden="true"></i><span></span>';
    ui(open.querySelector('span')!, 'textContent', () => text('Open ChatGPT', '打开 ChatGPT'));
    open.addEventListener('click', () => {
      void window.api.openChatGpt().then(reply => {
        if (!reply.ok) status.textContent = reply.error;
      }).catch(error => { status.textContent = String(error); });
    });
    const status = document.createElement('p');
    status.id = 'egoBrowserState';
    status.setAttribute('role', 'status');
    panel.append(heading, open, status);
    setup.append(panel);
  }
  const title = document.querySelector('[data-step="browser"] h3');
  if (title) ui(title, 'textContent', () => text('Ego browser', 'Ego 浏览器'));
}

export function paintEgoHostedBrowser(next: AppState): void {
  if (!isEgoHosted) return;
  const node = document.getElementById('bridgeState');
  if (!node) return;
  ui(node, 'textContent', () => next.bridge.present
    ? text('Ego browser connected', 'Ego 浏览器已连接')
    : next.bridge.running
      ? text('Waiting for the Ego browser connection', '等待 Ego 浏览器连接')
      : text('Ego browser connection stopped', 'Ego 浏览器连接已停止'));
  node.classList.toggle('is-warn', !next.bridge.present);
  const setupState = document.getElementById('egoBrowserState');
  if (setupState) ui(setupState, 'textContent', () => node.textContent ?? '');
}

export function egoBrowserSetup(next: AppState): { ready: boolean; choosingLocation: boolean } {
  return { ready: next.bridge.present, choosingLocation: true };
}

export function paintEgoHostedUi(next: AppState): void {
  if (!isEgoHosted) return;
  const background = document.getElementById('backgroundRunningCopy');
  if (background) ui(background, 'textContent', () => text('Managed by Ego', '由 Ego 管理'));
  paintEgoHostedBrowser(next);
}

export function egoUpdateSummary(next: AppState) {
  const missing = next.bridge.running && !next.bridge.present;
  return {
    text: missing
      ? text('Waiting for the Ego browser connection', '等待 Ego 浏览器连接')
      : `Ego · CoS ${next.update.current}`,
    tone: missing ? 'bad' as const : 'work' as const,
    notice: missing,
    extensionAction: null
  };
}
