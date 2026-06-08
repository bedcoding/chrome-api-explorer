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

// 검증 결과 영속 저장 — 다른 항목 추가/삭제로 리렌더돼도 verdict 살아남도록
// 호출자가 captures/customUrls 둘 다 모를 수 있으니 "있으면 저장, 없으면 무시" 시멘틱.
// 호출 성공 여부 반환 (true = 이 origin의 customUrls에 있었고 갱신함).
export async function updateCustomUrlVerdict(origin, url, verdict, durationMs, status) {
  const all = await loadAllCustomUrls();
  if (!all[origin]) return false;
  const e = all[origin].find((x) => x.url === url);
  if (!e) return false;
  e.lastVerdict = verdict;
  e.lastVerdictMs = durationMs;
  e.lastVerdictAt = Date.now();
  // 직접 추가 URL은 자연 호출이 잡힌 적 없어 lastStatus 비어있음 — 검증 결과 status로 채워주면
  // 사용자가 그 배지를 눌러 새 탭에서 응답 확인 가능.
  if (typeof status === 'number') e.lastStatus = status;
  await chrome.storage.local.set({ [KEY]: all });
  return true;
}
