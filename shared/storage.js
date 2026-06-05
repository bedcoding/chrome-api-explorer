// chrome.storage.local 래퍼 — 즐겨찾기 영속화.
// 데이터 모델:
//   favorites: Array<{
//     method: 'GET',
//     url: string,
//     label: string,
//     group: string,
//     note: string,
//     pages: string[]   // 어느 페이지에서 호출되는지
//   }>

const KEY_FAV = 'favorites_v1';

export async function loadFavorites() {
  const obj = await chrome.storage.local.get(KEY_FAV);
  return obj[KEY_FAV] ?? [];
}

async function writeAll(favorites) {
  await chrome.storage.local.set({ [KEY_FAV]: favorites });
  return favorites;
}

export async function saveFavorite(fav) {
  const list = await loadFavorites();
  const idx = list.findIndex((f) => f.method === fav.method && f.url === fav.url);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...fav };
  } else {
    list.push(fav);
  }
  return writeAll(list);
}

export async function removeFavorite(method, url) {
  const list = await loadFavorites();
  return writeAll(list.filter((f) => !(f.method === method && f.url === url)));
}

export async function updateFavorite(method, url, patch) {
  const list = await loadFavorites();
  const idx = list.findIndex((f) => f.method === method && f.url === url);
  if (idx < 0) return list;
  list[idx] = { ...list[idx], ...patch };
  return writeAll(list);
}

// 임의의 endpoint 배열을 동일 포맷으로 export (전체 export 용도)
export function exportEndpointsAsJson(endpoints, filenamePrefix = 'api-explorer') {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    endpoints,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `${filenamePrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

export function exportFavoritesAsJson(favorites) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    endpoints: favorites.map((f) => ({
      method: f.method,
      url: f.url,
      note: f.note || '',
      pages: f.pages || [],
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `api-explorer-favorites-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}
