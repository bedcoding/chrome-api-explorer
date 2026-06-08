// Service worker — webRequest로 GET 호출 캡쳐, chrome.storage에 영속.
//
// 동작 흐름:
//   1. webRequest.onBeforeRequest 에서 시작 시각 기록
//   2. webRequest.onCompleted 에서 종료. settings 검증 (enabled + domain whitelist)
//      → captures.recordCall() 로 영속 저장
//   3. sidepanel/options 에서 메시지로 데이터 요청

import {
  loadAllowDomains,
  loadCaptureEnabled,
  isDomainAllowed,
  originOf,
  hostnameOf,
  pathOf,
} from '../shared/settings.js';
import { recordCall, getCapturesByOrigin, getAllCaptures, clearOrigin, clearAll, updateCallNote, updateCallVerdict, removeCall, removePageFromOrigin } from '../shared/captures.js';

// 아이콘 클릭 → 사이드패널 열기
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch((err) => console.warn('sidePanel.setPanelBehavior failed:', err));

// 설정 캐시 (storage 조회 비용 줄이려고)
// settingsLoaded 가 false인 동안 캡쳐를 막아, SW 깨어난 직후 화이트리스트가 비어
// 보이는 짧은 윈도우에 노이즈가 들어오는 걸 방지.
let settingsCache = { enabled: false, allowDomains: [] };
let settingsLoaded = false;

async function reloadSettings() {
  settingsCache.enabled = await loadCaptureEnabled();
  settingsCache.allowDomains = await loadAllowDomains();
  settingsLoaded = true;
}
reloadSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('captureEnabled_v1' in changes) settingsCache.enabled = changes.captureEnabled_v1.newValue ?? false;
  if ('allowDomains_v1' in changes) settingsCache.allowDomains = changes.allowDomains_v1.newValue ?? [];
});

// 현재 활성 탭의 page path 추적 (호출이 어느 페이지에서 발생했는지 기록용)
const pageByTabId = new Map(); // tabId → "/ko/ranking"

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (url) pageByTabId.set(tabId, pathOf(url));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageByTabId.delete(tabId);
});

// 요청 시작 시점 기록
const pendingByRequestId = new Map();

// 캡쳐 대상 ResourceType.
// xmlhttprequest: 전통적 XHR + 일반 fetch (대부분 여기로 떨어짐)
// other: 일부 fetch (특히 ESM/SW 안에서 호출된 것)
// 의도적으로 image/stylesheet/script/font/media/sub_frame 등은 제외 — 정적 자산 노이즈
const CAPTURE_TYPES = ['xmlhttprequest', 'other'];

// API가 아닐 가능성이 매우 높은 확장자. 'other' 타입에 .js 빌드 청크가 가끔 섞여 들어와서 거름.
const STATIC_EXT_RE = /\.(js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|m3u8|ts|wasm)(\?|#|$)/i;

function isLikelyApi(url) {
  return !STATIC_EXT_RE.test(url);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'GET') return;
    if (details.tabId < 0) return;
    if (!settingsLoaded || !settingsCache.enabled) return;
    if (!isLikelyApi(details.url)) return;
    pendingByRequestId.set(details.requestId, { startedAt: details.timeStamp });
  },
  { urls: ['<all_urls>'], types: CAPTURE_TYPES }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.method !== 'GET') return;
    if (details.tabId < 0) return;
    if (!settingsLoaded || !settingsCache.enabled) return;
    if (!isLikelyApi(details.url)) return;

    const host = hostnameOf(details.url);
    if (!isDomainAllowed(host, settingsCache.allowDomains)) {
      pendingByRequestId.delete(details.requestId);
      return;
    }

    const pending = pendingByRequestId.get(details.requestId);
    pendingByRequestId.delete(details.requestId);
    const startedAt = pending?.startedAt ?? details.timeStamp;
    const durationMs = Math.max(0, Math.round(details.timeStamp - startedAt));

    resolvePage(details.tabId).then((page) => {
      recordCall({
        origin: originOf(details.url),
        method: details.method,
        url: details.url,
        status: details.statusCode,
        durationMs,
        sizeBytes: details.responseSize ?? 0,
        page,
        timestamp: Date.now(),
      });
    });
  },
  { urls: ['<all_urls>'], types: CAPTURE_TYPES }
);

// 캐시 히트하면 즉시. 미스 시 chrome.tabs.get 으로 보강 — SW가 깨어난 직후
// pageByTabId 가 비어있을 때 "(페이지 불명)" 누락 최소화.
async function resolvePage(tabId) {
  const cached = pageByTabId.get(tabId);
  if (cached) return cached;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      const p = pathOf(tab.url);
      pageByTabId.set(tabId, p);
      return p;
    }
  } catch {
    /* 탭 닫힘 등 — page 없음 */
  }
  return '';
}

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pendingByRequestId.delete(details.requestId);
  },
  { urls: ['<all_urls>'], types: CAPTURE_TYPES }
);

// 메시지 채널
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'getCapturesByOrigin': {
          const calls = await getCapturesByOrigin(msg.origin);
          sendResponse({ calls });
          return;
        }
        case 'getAllCaptures': {
          const all = await getAllCaptures();
          sendResponse({ all });
          return;
        }
        case 'clearOrigin': {
          await clearOrigin(msg.origin);
          sendResponse({ ok: true });
          return;
        }
        case 'removePageFromOrigin': {
          await removePageFromOrigin(msg.origin, msg.page);
          sendResponse({ ok: true });
          return;
        }
        case 'removeCall': {
          await removeCall(msg.origin, msg.method, msg.url);
          sendResponse({ ok: true });
          return;
        }
        case 'clearAll': {
          await clearAll();
          sendResponse({ ok: true });
          return;
        }
        case 'updateNote': {
          await updateCallNote(msg.origin, msg.method, msg.url, msg.note);
          sendResponse({ ok: true });
          return;
        }
        case 'updateVerdict': {
          await updateCallVerdict(msg.origin, msg.method, msg.url, msg.verdict, msg.durationMs);
          sendResponse({ ok: true });
          return;
        }
        case 'replayNaked': {
          const result = await replayNaked(msg.url);
          sendResponse(result);
          return;
        }
        default:
          sendResponse({ error: 'unknown message type' });
      }
    } catch (err) {
      sendResponse({ error: String(err?.message ?? err) });
    }
  })();
  return true;
});

async function replayNaked(url) {
  const startedAt = performance.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    });
    const durationMs = Math.round(performance.now() - startedAt);
    let verdict;
    if (res.status === 200) verdict = 'monitorable';
    else if (res.status === 401 || res.status === 403) verdict = 'authRequired';
    else verdict = 'other';
    return { status: res.status, durationMs, verdict };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    return { status: 0, durationMs, verdict: 'error', message: String(err?.message ?? err) };
  }
}
