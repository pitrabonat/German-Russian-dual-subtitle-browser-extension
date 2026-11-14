// Content script entry point. Picks the adapter for the current site and starts the controller.
import { isPageRequest } from '../shared/messages.ts';
import { Html5Adapter } from './adapters/html5.ts';
import type { SubtitleAdapter } from './adapters/types';
import { YouTubeAdapter } from './adapters/youtube.ts';
import { Controller } from './controller.ts';

declare global {
  interface Window {
    __mitlesenLoaded?: boolean;
  }
}

function pickAdapter(): SubtitleAdapter {
  const host = location.hostname;
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return new YouTubeAdapter();
  // Test hook: a page served from this computer may ask for the YouTube adapter
  // (tests/e2e/fixtures/youtube-mock.html).
  if ((host === '127.0.0.1' || host === 'localhost') && document.documentElement.dataset.mitlesenAdapter === 'youtube') return new YouTubeAdapter();
  return new Html5Adapter();
}

// The script can arrive twice (manifest entry plus a per-site registration); run once.
if (!window.__mitlesenLoaded) {
  window.__mitlesenLoaded = true;
  const controller = new Controller(pickAdapter());
  void controller.init();

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isPageRequest(message)) return undefined;
    const state = controller.pageState();
    // Frames without a video stay silent, so the frame that has one answers the popup.
    if (!state) return undefined;
    if (message.t === 'select-track') controller.selectTrack(message.id);
    sendResponse(state);
    return undefined;
  });
}
