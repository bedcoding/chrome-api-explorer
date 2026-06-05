// 사용자가 직접 추가한 URL 모음. 즐겨찾기와 별개.
// origin 별로 묶어 저장한다.
//
// chrome.storage.local.customUrls_v1 = {
//   [origin]: [{ method, url, note, addedAt }]
// }

const KEY = 'customUrls_v1';

export async function loadAllCustomUrls() {
  const obj = await chrome.storage.local.get(KEY);
  return obj[KEY] ?? {};
}

export async function getCustomUrlsByOrigin(origin) {
  const all = await loadAllCustomUrls();
  return all[origin] ?? [];
}

export async function addCustomUrl(origin, url) {
  const all = await loadAllCustomUrls();
  if (!all[origin]) all[origin] = [];
  if (all[origin].some((e) => e.url === url)) return all[origin]; // 중복
  all[origin].push({ method: 'GET', url, note: '', addedAt: Date.now() });
  await chrome.storage.local.set({ [KEY]: all });
  return all[origin];
}

export async function removeCustomUrl(origin, url) {
  const all = await loadAllCustomUrls();
  if (!all[origin]) return [];
  all[origin] = all[origin].filter((e) => e.url !== url);
  if (all[origin].length === 0) delete all[origin];
  await chrome.storage.local.set({ [KEY]: all });
  return all[origin] ?? [];
}

export async function updateCustomUrlNote(origin, url, note) {
  const all = await loadAllCustomUrls();
  if (!all[origin]) return;
  const e = all[origin].find((x) => x.url === url);
  if (!e) return;
  e.note = note;
  await chrome.storage.local.set({ [KEY]: all });
}
