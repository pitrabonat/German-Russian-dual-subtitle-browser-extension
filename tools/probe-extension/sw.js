// Service worker of the probe extension. `self.probe()` is called from the test harness.

async function tryOffscreen() {
  const out = { apiPresent: typeof chrome.offscreen !== 'undefined' };
  if (!out.apiPresent) return out;
  try {
    out.hasDocumentBefore = await chrome.offscreen.hasDocument?.();
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'API probe',
    });
    out.created = true;
    out.report = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'offscreen did not answer in 10 s' }), 10000);
      chrome.runtime.sendMessage({ type: 'offscreen-probe' }, (resp) => {
        clearTimeout(timer);
        resolve(resp ?? { error: chrome.runtime.lastError?.message ?? 'empty response' });
      });
    });
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      out.getContexts = ctx.length;
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

async function tryIdb() {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('probe', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('s');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return true;
  } catch (e) {
    return String(e);
  }
}

async function tryDnr() {
  if (!chrome.declarativeNetRequest) return { apiPresent: false };
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { urlFilter: '|http://127.0.0.1:11434/', resourceTypes: ['xmlhttprequest'] },
      }],
    });
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
    return { apiPresent: true, sessionRuleAccepted: rules.length === 1 };
  } catch (e) {
    return { apiPresent: true, error: String(e) };
  }
}

self.probe = async () => ({
  userAgent: navigator.userAgent,
  brands: navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`),
  manifestVersion: chrome.runtime.getManifest().manifest_version,
  sw: {
    worker: typeof Worker,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    crossOriginIsolated: self.crossOriginIsolated,
    gpu: 'gpu' in navigator,
    indexedDB: await tryIdb(),
    caches: typeof caches,
    hardwareConcurrency: navigator.hardwareConcurrency,
  },
  apis: {
    storageLocal: !!chrome.storage?.local,
    storageSync: !!chrome.storage?.sync,
    storageSession: !!chrome.storage?.session,
    scripting: !!chrome.scripting?.executeScript,
    tabs: !!chrome.tabs?.query,
    getContexts: !!chrome.runtime.getContexts,
    sidePanel: !!chrome.sidePanel,
  },
  dnr: await tryDnr(),
  offscreen: await tryOffscreen(),
});

// Does Ollama accept requests from an extension origin, and does a header rule fix a rejection?
self.ollamaOriginTest = async (base = 'http://127.0.0.1:11434', model = 'qwen3:4b') => {
  const get = async () => { try { return (await fetch(`${base}/api/version`)).status; } catch (e) { return String(e); } };
  const post = async () => { try { return (await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }) })).status; } catch (e) { return String(e); } };
  const before = { get: await get(), post: await post() };
  let rule = 'ok';
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [7],
      addRules: [{ id: 7, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] }, condition: { urlFilter: `|${base}/`, resourceTypes: ['xmlhttprequest'] } }],
    });
  } catch (e) { rule = String(e); }
  const after = { get: await get(), post: await post() };
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [7] }).catch(() => {});
  return { origin: self.location.origin, before, rule, after };
};
