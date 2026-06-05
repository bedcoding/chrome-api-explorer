// 사용자 설정: 도메인 화이트리스트 + 캡쳐 활성화 토글.
//
// allowDomains: string[]  — 빈 배열이면 전체 허용. 항목은 hostname suffix 매칭
//                           예: "example.com" → www.example.com, api.example.com 둘 다 통과
// captureEnabled: boolean — false면 webRequest 캡쳐 무시 (수동 일시정지용)

const KEY_DOMAINS = 'allowDomains_v1';
const KEY_ENABLED = 'captureEnabled_v1';

export async function loadAllowDomains() {
  const obj = await chrome.storage.local.get(KEY_DOMAINS);
  return obj[KEY_DOMAINS] ?? [];
}

export async function saveAllowDomains(list) {
  await chrome.storage.local.set({ [KEY_DOMAINS]: list });
}

export async function loadCaptureEnabled() {
  const obj = await chrome.storage.local.get(KEY_ENABLED);
  return obj[KEY_ENABLED] ?? false; // 기본 OFF — 엉뚱한 거 안 잡히도록
}

export async function saveCaptureEnabled(enabled) {
  await chrome.storage.local.set({ [KEY_ENABLED]: !!enabled });
}

export function isDomainAllowed(hostname, allowDomains) {
  if (!allowDomains || allowDomains.length === 0) return true;
  return allowDomains.some((d) => hostname === d || hostname.endsWith('.' + d));
}

export function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

export function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function pathOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}
