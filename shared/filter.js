// 필터 규칙: 사용자가 입력한 정규식 (대소문자 무시).
// 빈 문자열이면 전체 통과.

const KEY = 'filter_v1';

export async function loadFilter() {
  const obj = await chrome.storage.local.get(KEY);
  return obj[KEY] ?? '';
}

export async function saveFilter(pattern) {
  await chrome.storage.local.set({ [KEY]: pattern });
}

export function matchFilter(url, pattern) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(url);
  } catch {
    return url.includes(pattern);
  }
}
