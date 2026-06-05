// 영속 캡쳐 저장소. chrome.storage.local 에 origin 별로 그룹화해 보관.
//
// 스키마:
//   captures_v1: {
//     [origin]: {
//       [method + " " + url]: {
//         method, url,
//         lastStatus, lastDurationMs, lastSizeBytes,
//         firstSeenAt, lastSeenAt,
//         hitCount,
//         pages: string[]   // 호출이 일어난 페이지 path 누적 (중복 제거)
//       }
//     }
//   }
//
// 쓰기 빈도가 높아서(매 GET마다) 작은 in-memory 버퍼 + 디바운스 플러시로 처리.

const KEY = 'captures_v1';
let cache = null;          // {[origin]: {[key]: Call}}
let cacheLoaded = false;
let flushTimer = null;
const FLUSH_MS = 500;

async function ensureLoaded() {
  if (cacheLoaded) return;
  const obj = await chrome.storage.local.get(KEY);
  cache = obj[KEY] ?? {};
  cacheLoaded = true;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!cache) return;
    await chrome.storage.local.set({ [KEY]: cache });
  }, FLUSH_MS);
}

export async function recordCall({ origin, method, url, status, durationMs, sizeBytes, page, timestamp }) {
  await ensureLoaded();
  if (!cache[origin]) cache[origin] = {};
  const bucket = cache[origin];
  const key = `${method} ${url}`;
  const existing = bucket[key];

  if (existing) {
    existing.lastStatus = status;
    existing.lastDurationMs = durationMs;
    existing.lastSizeBytes = sizeBytes;
    existing.lastSeenAt = timestamp;
    existing.hitCount = (existing.hitCount ?? 0) + 1;
    if (page && !existing.pages.includes(page)) existing.pages.push(page);
  } else {
    bucket[key] = {
      method,
      url,
      lastStatus: status,
      lastDurationMs: durationMs,
      lastSizeBytes: sizeBytes,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      hitCount: 1,
      pages: page ? [page] : [],
    };
  }
  scheduleFlush();
}

export async function getAllCaptures() {
  await ensureLoaded();
  return cache;
}

export async function getCapturesByOrigin(origin) {
  await ensureLoaded();
  return cache[origin] ? Object.values(cache[origin]) : [];
}

export async function updateCallVerdict(origin, method, url, verdict, durationMs) {
  await ensureLoaded();
  const bucket = cache[origin];
  if (!bucket) return;
  const key = `${method} ${url}`;
  const existing = bucket[key];
  if (!existing) return;
  existing.lastVerdict = verdict;       // 'monitorable' | 'authRequired' | 'error' | 'other'
  existing.lastVerdictMs = durationMs;
  existing.lastVerdictAt = Date.now();
  await chrome.storage.local.set({ [KEY]: cache });
}

export async function updateCallNote(origin, method, url, note) {
  await ensureLoaded();
  const bucket = cache[origin];
  if (!bucket) return;
  const key = `${method} ${url}`;
  const existing = bucket[key];
  if (!existing) return;
  existing.note = note;
  await chrome.storage.local.set({ [KEY]: cache });
}

export async function removeCall(origin, method, url) {
  await ensureLoaded();
  const bucket = cache[origin];
  if (!bucket) return;
  const key = `${method} ${url}`;
  delete bucket[key];
  if (Object.keys(bucket).length === 0) delete cache[origin];
  await chrome.storage.local.set({ [KEY]: cache });
}

export async function clearOrigin(origin) {
  await ensureLoaded();
  delete cache[origin];
  await chrome.storage.local.set({ [KEY]: cache });
}

export async function clearAll() {
  cache = {};
  await chrome.storage.local.set({ [KEY]: cache });
}

// storage 가 외부(options 페이지 등)에서 바뀌면 캐시 무효화
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) {
      cache = changes[KEY].newValue ?? {};
    }
  });
}
