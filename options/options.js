import { loadFavorites, exportFavoritesAsJson } from '../shared/storage.js';
import { loadAllowDomains, saveAllowDomains } from '../shared/settings.js';

const els = {
  domainsInput: document.getElementById('domainsInput'),
  saveDomainsBtn: document.getElementById('saveDomainsBtn'),
  saveDomainsMsg: document.getElementById('saveDomainsMsg'),
  captureCount: document.getElementById('captureCount'),
  apiCount: document.getElementById('apiCount'),
  favCount: document.getElementById('favCount'),
  exportBtn: document.getElementById('exportBtn'),
  clearCapturesBtn: document.getElementById('clearCapturesBtn'),
  clearFavBtn: document.getElementById('clearFavBtn'),
};

async function init() {
  const domains = await loadAllowDomains();
  els.domainsInput.value = domains.join('\n');

  await refreshCounts();

  els.saveDomainsBtn.addEventListener('click', async () => {
    const list = els.domainsInput.value
      .split('\n')
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''))
      .filter(Boolean);
    await saveAllowDomains(list);
    flash(els.saveDomainsMsg, '저장됨');
  });

  els.exportBtn.addEventListener('click', async () => {
    const favs = await loadFavorites();
    if (favs.length === 0) { alert('즐겨찾기가 비어있습니다.'); return; }
    exportFavoritesAsJson(favs);
  });

  els.clearCapturesBtn.addEventListener('click', async () => {
    if (!confirm('정말 모든 캡쳐 데이터를 삭제하시겠습니까? (즐겨찾기는 유지됨)')) return;
    await chrome.runtime.sendMessage({ type: 'clearAll' });
    await refreshCounts();
  });

  els.clearFavBtn.addEventListener('click', async () => {
    if (!confirm('정말 모든 즐겨찾기를 삭제하시겠습니까?')) return;
    await chrome.storage.local.set({ favorites_v1: [] });
    await refreshCounts();
  });

}

async function refreshCounts() {
  const obj = await chrome.storage.local.get(['captures_v1', 'favorites_v1']);
  const captures = obj.captures_v1 ?? {};
  const favorites = obj.favorites_v1 ?? [];
  const originCount = Object.keys(captures).length;
  let apiCount = 0;
  for (const o of Object.values(captures)) apiCount += Object.keys(o).length;
  els.captureCount.textContent = originCount;
  els.apiCount.textContent = apiCount;
  els.favCount.textContent = favorites.length;
}

function flash(el, msg) {
  el.textContent = msg;
  setTimeout(() => (el.textContent = ''), 1500);
}

init();
