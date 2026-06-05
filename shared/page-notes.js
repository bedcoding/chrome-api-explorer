// 페이지(path) 단위 메모. origin + page 조합 키로 영속화.
//
// chrome.storage.local.pageNotes_v1 = {
//   [origin]: {
//     [pagePath]: string
//   }
// }

const KEY = 'pageNotes_v1';

export async function loadPageNotes() {
  const obj = await chrome.storage.local.get(KEY);
  return obj[KEY] ?? {};
}

export async function getPageNote(origin, page) {
  const all = await loadPageNotes();
  return all[origin]?.[page] ?? '';
}

export async function setPageNote(origin, page, note) {
  const all = await loadPageNotes();
  if (!all[origin]) all[origin] = {};
  if (note) {
    all[origin][page] = note;
  } else {
    delete all[origin][page];
    if (Object.keys(all[origin]).length === 0) delete all[origin];
  }
  await chrome.storage.local.set({ [KEY]: all });
}
