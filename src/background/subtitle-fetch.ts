// Downloads a subtitle file for a content script (Netflix announces its text tracks as CDN
// addresses the page itself cannot read across origins). The fetch runs with the extension's
// access to every site, so which addresses a page may ask for is kept narrow.
import { makeError, toError, type ContentResponse } from '../shared/messages.ts';
import { isLoopback } from '../shared/settings.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** Netflix serves timed text from its CDN (nflxvideo.net) and, for some titles, its asset hosts. */
const NETFLIX_FILE_HOST = /(^|\.)(nflxvideo\.net|nflxso\.net|nflxext\.com|netflix\.com)$/;

/**
 * Netflix pages may ask for Netflix hosts over https. Pages on this computer (the tests) may ask
 * for loopback addresses. Any other page gets nothing.
 */
export function subtitleUrlAllowed(fileUrl: string, pageUrl: string | undefined): boolean {
  let file: URL;
  let page: URL;
  try {
    file = new URL(fileUrl);
    page = new URL(pageUrl ?? '');
  } catch {
    return false;
  }
  if (file.username || file.password) return false;
  if (page.protocol === 'https:' && /(^|\.)netflix\.com$/.test(page.hostname)) {
    return file.protocol === 'https:' && NETFLIX_FILE_HOST.test(file.hostname);
  }
  if (/^https?:$/.test(page.protocol) && isLoopback(page.href)) {
    return /^https?:$/.test(file.protocol) && isLoopback(file.href);
  }
  return false;
}

export async function fetchSubtitles(url: string, fetchImpl: typeof fetch = fetch): Promise<ContentResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // No cookies, no redirects: a signed CDN address either answers or it does not.
    const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (!response.ok) return { ok: false, error: makeError('bad-response', `сервер ответил ${response.status}`) };
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) return { ok: false, error: makeError('bad-response', 'файл субтитров больше 8 МБ') };
    const text = await response.text();
    if (text.length > MAX_BYTES) return { ok: false, error: makeError('bad-response', 'файл субтитров больше 8 МБ') };
    return { ok: true, text };
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, error: makeError('timeout', 'файл субтитров не загрузился за 20 с') };
    return { ok: false, error: makeError('unreachable', toError(e).message) };
  } finally {
    clearTimeout(timer);
  }
}
