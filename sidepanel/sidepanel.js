import { loadFavorites, saveFavorite, removeFavorite, updateFavorite } from '../shared/storage.js';
import { loadFilter, saveFilter, matchFilter } from '../shared/filter.js';
import { loadCaptureEnabled, saveCaptureEnabled, loadAllowDomains, saveAllowDomains, isDomainAllowed, originOf, hostnameOf } from '../shared/settings.js';
import { getPageNote, setPageNote } from '../shared/page-notes.js';
import { loadAllCustomUrls, getCustomUrlsByOrigin, addCustomUrl, removeCustomUrl, updateCustomUrlNote } from '../shared/custom-urls.js';

const els = {
  favOnlyToggle: document.getElementById('favOnlyToggle'),
  capturedList: document.getElementById('capturedList'),
  filterInput: document.getElementById('filterInput'),
  exportMenu: document.getElementById('exportMenu'),
  exportBtn: document.getElementById('exportBtn'),
  exportFavBtn: document.getElementById('exportFavBtn'),
  exportAllBtn: document.getElementById('exportAllBtn'),
  exportBackupBtn: document.getElementById('exportBackupBtn'),
  importMenu: document.getElementById('importMenu'),
  importBtn: document.getElementById('importBtn'),
  importOverwriteBtn: document.getElementById('importOverwriteBtn'),
  importMergeBtn: document.getElementById('importMergeBtn'),
  importFileInput: document.getElementById('importFileInput'),
  notesMenu: document.getElementById('notesMenu'),
  notesBtn: document.getElementById('notesBtn'),
  notesExpandFilledBtn: document.getElementById('notesExpandFilledBtn'),
  notesExpandAllBtn: document.getElementById('notesExpandAllBtn'),
  notesCollapseAllBtn: document.getElementById('notesCollapseAllBtn'),
  favAddUrl: document.getElementById('favAddUrl'),
  favAddBtn: document.getElementById('favAddBtn'),
  exportModal: document.getElementById('exportModal'),
  exportModalTitle: document.getElementById('exportModalTitle'),
  exportModalClose: document.getElementById('exportModalClose'),
  exportPreview: document.getElementById('exportPreview'),
  exportSummary: document.getElementById('exportSummary'),
  exportCopyBtn: document.getElementById('exportCopyBtn'),
  exportDownloadBtn: document.getElementById('exportDownloadBtn'),
  optionsBtn: document.getElementById('optionsBtn'),
  captureToggle: document.getElementById('captureToggle'),
  captureStateLabel: document.getElementById('captureStateLabel'),
  groupToggle: document.getElementById('groupToggle'),
  originSelect: document.getElementById('originSelect'),
  clearOriginBtn: document.getElementById('clearOriginBtn'),
  purgeNoiseBtn: document.getElementById('purgeNoiseBtn'),
  whitelistInput: document.getElementById('whitelistInput'),
  counter: document.getElementById('counter'),
  callRowTpl: document.getElementById('callRowTpl'),
  groupHeaderTpl: document.getElementById('groupHeaderTpl'),
};

let activeTabId = null;        // 사용자가 보고 있는 브라우저 탭 id (origin 추정용)
let selectedOrigin = '';       // dropdown에서 선택된 origin
let allCaptures = {};          // {origin: {key: Call}}
let currentCalls = [];         // selectedOrigin에 해당하는 Call[]
let customUrls = [];           // selectedOrigin에 해당하는 사용자 직접 추가 URL
let favorites = [];
let favOnly = false;
let currentFilter = '';
let groupByPage = false;

const LAST_ORIGIN_KEY = 'lastSelectedOrigin_v1';
const GROUP_BY_PAGE_KEY = 'groupByPage_v1';
const COLLAPSED_GROUPS_KEY = 'collapsedGroups_v1'; // { [origin]: [page, ...] }
const FAV_ONLY_KEY = 'favOnly_v1';
const PAGE_ORDER_KEY = 'pageOrder_v1'; // { [origin]: [page, ...] } — 사용자 지정 순서

let collapsedGroups = {}; // 현재 origin의 접힌 페이지 Set
let pageOrder = {}; // { [origin]: [page, ...] } — 사용자 지정 페이지 그룹 순서

// 메모/검색 input에 포커스가 있을 때 리렌더가 일어나면 input 노드가 교체돼
// 포커스가 사라진다. 포커스 중에는 리렌더를 큐잉했다가 blur 시 1회 실행한다.
let pendingRender = false;
// Export용 endpoint 객체 생성. 즐겨찾기 정보를 base로, 캡쳐된 metadata(timing/상태/검증)와 머지.
function buildExportEndpoint(base, cached) {
  const out = {
    method: base.method,
    url: base.url,
    note: base.note || cached?.note || '',
    pages: base.pages || cached?.pages || [],
  };
  if (cached) {
    if (cached.lastStatus != null) out.lastStatus = cached.lastStatus;
    if (cached.lastDurationMs != null) out.lastDurationMs = cached.lastDurationMs;
    if (cached.lastVerdict) out.lastVerdict = cached.lastVerdict;
    if (cached.lastVerdictMs != null) out.lastVerdictMs = cached.lastVerdictMs;
  }
  return out;
}

// 백업 데이터 병합. 객체형 key(captures_v1, customUrls_v1, pageNotes_v1)는 깊은 머지,
// 배열형(favorites_v1, allowDomains_v1)은 중복 제거 후 합치기, 그 외는 incoming 우선.
function mergeBackup(current, incoming) {
  const out = { ...current };
  for (const [key, val] of Object.entries(incoming)) {
    const cur = current[key];
    if (Array.isArray(val) && Array.isArray(cur)) {
      const seen = new Set();
      const dedupKey = (item) => typeof item === 'object'
        ? `${item.method ?? ''}|${item.url ?? item}` : String(item);
      out[key] = [...cur, ...val].filter((item) => {
        const k = dedupKey(item);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    } else if (val && typeof val === 'object' && cur && typeof cur === 'object' && !Array.isArray(val)) {
      // 객체형: 1단계 깊은 머지 (captures_v1의 origin → method+url 등)
      out[key] = { ...cur };
      for (const [k2, v2] of Object.entries(val)) {
        if (v2 && typeof v2 === 'object' && !Array.isArray(v2) && cur[k2] && typeof cur[k2] === 'object') {
          out[key][k2] = { ...cur[k2], ...v2 };
        } else {
          out[key][k2] = v2;
        }
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

function isTypingInEditableInput() {
  // 메모 input들만 보호 대상. 검색/화이트리스트는 입력 즉시 반영이 사용자 기대.
  const a = document.activeElement;
  if (!a) return false;
  return a.matches?.('.note, .group-note');
}

// 메모 펼침 상태 영속화 — 리렌더 후에도 어느 행이 펼쳐져 있었는지 복원.
// key = `${method} ${url}` (call key와 동일 규칙)
const expandedRows = new Set();

// 자기 자신이 일으킨 메모 저장으로 인한 storage onChanged 리렌더 억제.
// updateNote 호출 직전 true로 세팅하고, onChanged 리스너에서 captures_v1 변경 1회를 무시한다.
let suppressNextCapturesChange = false;
let suppressNextCustomUrlsChange = false;

async function init() {
  // 마지막 선택 도메인 복원 — 활성 탭 origin보다 우선
  const stored = await chrome.storage.local.get([LAST_ORIGIN_KEY, GROUP_BY_PAGE_KEY, COLLAPSED_GROUPS_KEY, FAV_ONLY_KEY, PAGE_ORDER_KEY]);
  if (stored[LAST_ORIGIN_KEY]) selectedOrigin = stored[LAST_ORIGIN_KEY];
  groupByPage = !!stored[GROUP_BY_PAGE_KEY];
  els.groupToggle.checked = groupByPage;
  collapsedGroups = stored[COLLAPSED_GROUPS_KEY] || {};
  pageOrder = stored[PAGE_ORDER_KEY] || {};
  favOnly = !!stored[FAV_ONLY_KEY];
  els.favOnlyToggle.classList.toggle('on', favOnly);

  await syncActiveTab();

  currentFilter = await loadFilter();
  els.filterInput.value = currentFilter;

  els.captureToggle.checked = await loadCaptureEnabled();
  updateCaptureLabel();

  await refreshWhitelistView();
  favorites = await loadFavorites();
  await reloadCaptures();

  bindEvents();
  startWatchers();
}

async function refreshWhitelistView() {
  const list = await loadAllowDomains();
  // 사용자가 입력 중이면 덮어쓰지 않음
  if (document.activeElement !== els.whitelistInput) {
    els.whitelistInput.value = list.join(', ');
  }
}

async function syncActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0]?.id ?? null;
  // 활성 탭의 origin은 더 이상 자동 선택에 쓰지 않음 — 마지막 사용자 선택이 우선.
  // (populateOriginSelect 가 prev 값을 유지하는 정책이라 여기서 손대지 않음)
}

function bindEvents() {
  // 그룹 드래그 — 리스트 컨테이너에 위임해서 헤더 사이 사각지대 없도록
  setupListDragDelegation();

  // 모든 보호 대상 input의 blur 시점에 보류된 리렌더 처리
  els.filterInput.addEventListener('blur', flushPendingRender);
  els.whitelistInput.addEventListener('blur', flushPendingRender);
  els.favAddUrl?.addEventListener('blur', flushPendingRender);

  els.favOnlyToggle.addEventListener('click', async () => {
    favOnly = !favOnly;
    els.favOnlyToggle.classList.toggle('on', favOnly);
    await chrome.storage.local.set({ [FAV_ONLY_KEY]: favOnly });
    renderCurrent();
  });

  els.filterInput.addEventListener('input', async (e) => {
    currentFilter = e.target.value;
    await saveFilter(currentFilter);
    renderCurrent();
  });

  let whitelistDebounce = null;
  els.whitelistInput.addEventListener('input', () => {
    clearTimeout(whitelistDebounce);
    whitelistDebounce = setTimeout(async () => {
      const list = els.whitelistInput.value
        .split(',')
        .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''))
        .filter(Boolean);
      await saveAllowDomains(list);
    }, 400);
  });

  // 푸터 드롭업 3종(내보내기/불러오기/메모): 트리거 클릭으로 토글, 다른 메뉴는 자동으로 닫힘.
  const footerMenus = [els.exportMenu, els.importMenu, els.notesMenu];
  const openMenu = (target) => {
    for (const m of footerMenus) if (m !== target) m.classList.remove('open');
    target.classList.toggle('open');
  };
  els.exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(els.exportMenu);
  });
  document.addEventListener('click', (e) => {
    for (const m of footerMenus) {
      if (m && !m.contains(e.target)) m.classList.remove('open');
    }
  });

  els.exportFavBtn.addEventListener('click', () => {
    els.exportMenu.classList.remove('open');
    if (favorites.length === 0) {
      alert('즐겨찾기가 비어있습니다.\nGET 배지(☆)를 클릭해 추가하거나 "전체"로 내보내세요.');
      return;
    }
    // 캡쳐된 metadata와 머지해서 timing/상태/검증 결과 포함
    const callsByKey = new Map(currentCalls.map((c) => [`${c.method} ${c.url}`, c]));
    const endpoints = favorites.map((f) => {
      const cached = callsByKey.get(`${f.method} ${f.url}`);
      return buildExportEndpoint(f, cached);
    });
    openExportModal('★ 즐겨찾기 Export', endpoints, 'api-explorer-favorites');
  });

  // 메모 드롭업 트리거
  els.notesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(els.notesMenu);
  });
  // 불러오기 드롭업 트리거
  els.importBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(els.importMenu);
  });

  const forEachRow = (fn) => {
    for (const li of els.capturedList.querySelectorAll('li.row')) {
      const rb = li.querySelector('.row-bottom');
      const noteEl = li.querySelector('.note');
      const key = li.dataset.rowKey;
      if (rb) fn(rb, noteEl, key);
    }
  };

  els.notesExpandFilledBtn.addEventListener('click', () => {
    els.notesMenu.classList.remove('open');
    forEachRow((rb, noteEl, key) => {
      const expand = !!(noteEl && noteEl.value.trim());
      rb.hidden = !expand;
      if (key) (expand ? expandedRows.add(key) : expandedRows.delete(key));
    });
  });
  els.notesExpandAllBtn.addEventListener('click', () => {
    els.notesMenu.classList.remove('open');
    forEachRow((rb, _n, key) => { rb.hidden = false; if (key) expandedRows.add(key); });
  });
  els.notesCollapseAllBtn.addEventListener('click', () => {
    els.notesMenu.classList.remove('open');
    forEachRow((rb, _n, key) => { rb.hidden = true; if (key) expandedRows.delete(key); });
  });

  els.exportAllBtn.addEventListener('click', () => {
    els.exportMenu.classList.remove('open');
    if (currentCalls.length === 0) {
      alert('현재 선택된 도메인에 캡쳐된 API가 없습니다.');
      return;
    }
    const endpoints = currentCalls.map((c) => buildExportEndpoint(c, c));
    const prefix = `api-explorer-all-${hostnameOf(selectedOrigin) || 'unknown'}`;
    openExportModal(`전체 Export — ${hostnameOf(selectedOrigin) || ''}`, endpoints, prefix);
  });

  // 전체 백업: 모든 storage.local 데이터를 JSON 파일로 다운로드
  els.exportBackupBtn.addEventListener('click', async () => {
    els.exportMenu.classList.remove('open');
    const all = await chrome.storage.local.get(null);
    const payload = {
      _format: 'api-explorer-backup',
      _version: 1,
      _exportedAt: new Date().toISOString(),
      data: all,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `api-explorer-backup-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // 불러오기: 덮어쓰기 / 병합
  let importMode = null; // 'overwrite' | 'merge'
  els.importOverwriteBtn.addEventListener('click', () => {
    els.importMenu.classList.remove('open');
    if (!confirm('현재 저장된 모든 데이터를 백업 파일 내용으로 덮어씁니다.\n계속할까요?')) return;
    importMode = 'overwrite';
    els.importFileInput.click();
  });
  els.importMergeBtn.addEventListener('click', () => {
    els.importMenu.classList.remove('open');
    importMode = 'merge';
    els.importFileInput.click();
  });
  els.importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 다시 선택할 수 있도록 reset
    if (!file || !importMode) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (payload._format !== 'api-explorer-backup' || !payload.data) {
        alert('백업 파일 형식이 올바르지 않습니다.');
        return;
      }
      const incoming = payload.data;
      if (importMode === 'overwrite') {
        await chrome.storage.local.clear();
        await chrome.storage.local.set(incoming);
        alert('덮어쓰기 완료. 사이드패널을 새로 열면 반영됩니다.');
      } else {
        // 병합: 객체형 key는 깊은 머지(같은 origin/key는 incoming 우선), 배열형은 dedupe로 합침
        const current = await chrome.storage.local.get(null);
        const merged = mergeBackup(current, incoming);
        await chrome.storage.local.set(merged);
        alert('병합 완료. 사이드패널을 새로 열면 반영됩니다.');
      }
      // 자체 리로드
      await reloadCaptures();
      favorites = await loadFavorites();
      await refreshWhitelistView();
      renderCurrent();
    } catch (err) {
      console.error(err);
      alert(`복원 실패: ${err?.message ?? err}`);
    } finally {
      importMode = null;
    }
  });

  els.favAddBtn.addEventListener('click', addCustomFavorite);
  els.favAddUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomFavorite();
  });

  els.exportModalClose.addEventListener('click', closeExportModal);
  els.exportModal.querySelector('.modal-backdrop').addEventListener('click', closeExportModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.exportModal.classList.contains('hidden')) closeExportModal();
  });
  els.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  els.captureToggle.addEventListener('change', async (e) => {
    await saveCaptureEnabled(e.target.checked);
    updateCaptureLabel();
  });

  els.groupToggle.addEventListener('change', async (e) => {
    groupByPage = e.target.checked;
    await chrome.storage.local.set({ [GROUP_BY_PAGE_KEY]: groupByPage });
    renderCurrent();
  });

  els.originSelect.addEventListener('change', async (e) => {
    selectedOrigin = e.target.value;
    await chrome.storage.local.set({ [LAST_ORIGIN_KEY]: selectedOrigin });
    pickCurrentCalls();
    await refreshCustomUrls();
    renderCurrent();
  });

  els.clearOriginBtn.addEventListener('click', async () => {
    if (!selectedOrigin) return;
    if (!confirm(`${selectedOrigin} 의 캡쳐와 직접 추가 항목을 모두 삭제할까요?`)) return;
    await chrome.runtime.sendMessage({ type: 'clearOrigin', origin: selectedOrigin });
    // 직접 추가 항목도 같이 정리
    for (const c of customUrls) {
      await removeCustomUrl(selectedOrigin, c.url);
    }
    await reloadCaptures();
  });

  els.purgeNoiseBtn.addEventListener('click', async () => {
    const allowDomains = await loadAllowDomains();
    if (allowDomains.length === 0) {
      alert('도메인 목록이 비어있어 노이즈 기준이 없습니다.\n상단 "도메인" 칸에 먼저 등록하세요.');
      return;
    }
    // 캡쳐 + 직접 추가 두 저장소 모두에서 origin 모아 검사
    const allCustom = await loadAllCustomUrls();
    const allOrigins = new Set([
      ...Object.keys(allCaptures),
      ...Object.keys(allCustom),
    ]);
    const noise = [...allOrigins].filter((o) => !isDomainAllowed(hostnameOf(o), allowDomains));
    if (noise.length === 0) {
      alert('제거할 노이즈 도메인이 없습니다.');
      return;
    }
    if (!confirm(`도메인 목록 밖 ${noise.length}개 그룹을 삭제할까요?\n(캡쳐 + 직접 추가 항목 모두)\n\n${noise.join('\n')}`)) return;
    for (const ori of noise) {
      // 캡쳐 삭제
      await chrome.runtime.sendMessage({ type: 'clearOrigin', origin: ori });
      // 직접 추가도 origin 단위로 청소
      if (allCustom[ori]) {
        for (const c of allCustom[ori]) {
          await removeCustomUrl(ori, c.url);
        }
      }
    }
    await reloadCaptures();
  });
}

function updateCaptureLabel() {
  const on = els.captureToggle.checked;
  els.captureStateLabel.textContent = on ? 'ON' : 'OFF';
  els.captureStateLabel.classList.toggle('on', on);
}

function startWatchers() {
  chrome.tabs.onActivated.addListener(async () => {
    await syncActiveTab();
    populateOriginSelect();
    pickCurrentCalls();
    renderCurrent();
  });

  // storage 변경 (background가 새 호출 저장) → 자동 갱신
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('captures_v1' in changes) {
      const prevAll = allCaptures;
      allCaptures = changes.captures_v1.newValue ?? {};
      // 자기가 일으킨 메모 저장은 본 패널에 영향 없으니 리렌더 스킵
      if (suppressNextCapturesChange) {
        suppressNextCapturesChange = false;
      } else {
        populateOriginSelect();
        pickCurrentCalls();
        // 새 URL이 들어왔으면 메모 입력 가드 무시하고 강제 렌더 (그렇지 않으면 보류된 채 안 풀리는 케이스 있음)
        const prevCount = countCalls(prevAll);
        const nextCount = countCalls(allCaptures);
        if (nextCount > prevCount) renderCurrentNow();
        else renderCurrent();
        updateCounter();
      }
    }
    if ('favorites_v1' in changes) {
      favorites = changes.favorites_v1.newValue ?? [];
      renderCurrent();
    }
    if ('allowDomains_v1' in changes) {
      refreshWhitelistView();
    }
    if ('customUrls_v1' in changes) {
      if (suppressNextCustomUrlsChange) {
        suppressNextCustomUrlsChange = false;
        // customUrls 캐시는 갱신해야 함 (다음 렌더 시 일관성)
        refreshCustomUrls();
      } else {
        refreshCustomUrls().then(renderCurrent);
      }
    }
  });
}

async function reloadCustomUrlsAndRender() {
  await refreshCustomUrls();
  renderCurrent();
}

async function reloadCaptures() {
  const res = await chrome.runtime.sendMessage({ type: 'getAllCaptures' });
  allCaptures = res?.all ?? {};
  populateOriginSelect();
  pickCurrentCalls();
  await refreshCustomUrls();
  renderCurrent();
  updateCounter();
}

function populateOriginSelect() {
  const origins = Object.keys(allCaptures).sort();
  const prev = selectedOrigin;
  els.originSelect.innerHTML = '';

  // 항상 빈 첫 옵션을 둠 — 사용자가 명시적으로 골라야 데이터가 표시됨.
  // 첫 화면에서 엉뚱한 노이즈 도메인이 선택돼 보이는 혼란 방지.
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = origins.length === 0 ? '(저장된 도메인 없음)' : '(도메인 선택)';
  els.originSelect.appendChild(placeholder);

  if (origins.length === 0) {
    selectedOrigin = '';
    return;
  }

  for (const ori of origins) {
    const count = Object.keys(allCaptures[ori]).length;
    const opt = document.createElement('option');
    opt.value = ori;
    opt.textContent = `${ori}  (${count})`;
    els.originSelect.appendChild(opt);
  }

  // 이전 선택이 살아있으면 유지. 활성 탭 origin이 목록에 있으면 그걸 선택.
  // 둘 다 아니면 비워둠(첫 화면에서 임의의 도메인 자동 선택 안 함).
  if (prev && origins.includes(prev)) {
    selectedOrigin = prev;
  } else if (origins.includes(selectedOrigin)) {
    /* keep */
  } else {
    selectedOrigin = '';
  }
  els.originSelect.value = selectedOrigin;
}

function pickCurrentCalls() {
  const bucket = allCaptures[selectedOrigin];
  currentCalls = bucket ? Object.values(bucket) : [];
}

async function refreshCustomUrls() {
  customUrls = selectedOrigin ? await getCustomUrlsByOrigin(selectedOrigin) : [];
}

function countCalls(captures) {
  let total = 0;
  for (const o of Object.values(captures ?? {})) total += Object.keys(o).length;
  return total;
}

function updateCounter() {
  const totalOrigins = Object.keys(allCaptures).length;
  const totalCalls = countCalls(allCaptures);
  els.counter.textContent = `${totalOrigins} 도메인 · ${totalCalls} API`;
}

function renderCurrent() {
  // 사용자가 메모/검색 input에 글자를 입력 중이면 리렌더를 보류.
  // 포커스가 빠지는 시점(input의 blur 핸들러)에서 한 번만 실행한다.
  if (isTypingInEditableInput()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  renderCurrentNow();
}

function flushPendingRender() {
  if (pendingRender) renderCurrent();
}

function renderCurrentNow() {
  // 캡쳐 + 사용자 직접 추가를 합쳐서 렌더 (직접 추가는 isCustom 표식)
  const customCalls = customUrls.map((c) => ({
    method: c.method,
    url: c.url,
    pages: [],
    lastStatus: null,
    lastDurationMs: 0,
    lastSizeBytes: 0,
    hitCount: 0,
    note: c.note || '',
    addedAt: c.addedAt ?? 0,
    isCustom: true,
  }));
  // 추가된 순서대로 위→아래로 쌓이도록 정렬 (오래된 것이 위, 최신이 아래).
  // 캡쳐는 firstSeenAt, 직접 추가는 addedAt(없으면 0) 기준.
  const combined = [...currentCalls, ...customCalls].sort((a, b) => {
    const ta = a.firstSeenAt ?? a.addedAt ?? 0;
    const tb = b.firstSeenAt ?? b.addedAt ?? 0;
    return ta - tb;
  });

  if (!favOnly) {
    renderRows(combined);
    return;
  }
  // favOnly: favorites + customCalls 만 표시
  const callsByKey = new Map(combined.map((c) => [`${c.method} ${c.url}`, c]));
  const favCalls = favorites.map((f) => {
    const cached = callsByKey.get(`${f.method} ${f.url}`);
    return cached || {
      method: f.method,
      url: f.url,
      pages: f.pages || [],
      lastStatus: null,
      lastDurationMs: 0,
      lastSizeBytes: 0,
      hitCount: 0,
      note: f.note || '',
    };
  });
  renderRows(favCalls, /* favoritesOnly */ true);
}

function renderRows(calls, favoritesOnly = false) {
  els.capturedList.innerHTML = '';
  const filtered = calls.filter((c) =>
    matchFilter(c.url, currentFilter) || matchFilter(c.note || '', currentFilter)
  );

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    if (favoritesOnly) {
      li.textContent = favorites.length === 0
        ? '즐겨찾기 없음. 캡쳐 행의 GET 배지(☆)를 클릭하거나 상단에서 URL 직접 추가.'
        : '필터에 걸리는 즐겨찾기가 없습니다.';
    } else if (!els.captureToggle.checked) {
      li.textContent = '감지 OFF 상태입니다. 상단 토글을 켜세요.';
    } else if (!selectedOrigin) {
      li.textContent = Object.keys(allCaptures).length === 0
        ? '아직 캡쳐된 호출 없음. 페이지를 둘러보세요.'
        : '위에서 도메인을 선택하세요.';
    } else if (currentCalls.length === 0) {
      li.textContent = `${selectedOrigin} 에 캡쳐된 호출이 아직 없습니다.`;
    } else {
      li.textContent = '필터에 걸리는 호출이 없습니다.';
    }
    els.capturedList.appendChild(li);
    return;
  }

  if (groupByPage) {
    renderGrouped(filtered);
  } else {
    for (const call of filtered) appendCallRow(call);
  }
}

// 드래그 중인 페이지 그룹 추적
let draggingPage = null;
let dragGhostEl = null;
let dropPlaceholderEl = null;
let dropPlaceholderAbove = false; // placeholder가 현재 헤더의 위에 있는지

function clearDropPlaceholder() {
  if (dropPlaceholderEl) {
    dropPlaceholderEl.remove();
    dropPlaceholderEl = null;
  }
  document.querySelectorAll('.group-header.drop-target')
    .forEach((el) => el.classList.remove('drop-target'));
}

function attachGroupDragHandlers(header, page) {
  // 헤더별로는 dragstart/dragend만 — dragover/drop은 리스트 컨테이너에 위임 (사각지대 방지)
  header.addEventListener('dragstart', (e) => {
    draggingPage = page;
    header.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', page); // Firefox 호환
    // 마우스 옆에 떠다니는 칩 — 잡은 그룹 라벨을 명확히 보이게
    dragGhostEl = document.createElement('div');
    dragGhostEl.className = 'drag-ghost';
    dragGhostEl.textContent = page;
    document.body.appendChild(dragGhostEl);
    e.dataTransfer.setDragImage(dragGhostEl, 12, 12);
  });
  header.addEventListener('dragend', () => {
    draggingPage = null;
    header.classList.remove('dragging');
    clearDropPlaceholder();
    if (dragGhostEl) {
      dragGhostEl.remove();
      dragGhostEl = null;
    }
    // 드래그 직후 따라오는 click 이벤트가 토글을 trigger하지 않도록 잠깐 무시
    header.dataset.dragJustEnded = '1';
    setTimeout(() => { delete header.dataset.dragJustEnded; }, 50);
  });
}

// 그룹 영역의 끝 다음 노드 = 다음 group-header, 또는 리스트 끝(null).
// insertBefore의 두번째 인자로 그대로 쓸 수 있게 설계.
function findGroupEndAnchor(header) {
  let n = header.nextSibling;
  while (n && !(n.classList && n.classList.contains('group-header'))) {
    n = n.nextSibling;
  }
  return n; // 다음 그룹 헤더 또는 null
}

// 마우스 Y좌표에 가장 가까운 드롭 가능 그룹 헤더 + 위/아래 판정
function findDropTarget(clientY) {
  const headers = [...els.capturedList.querySelectorAll('li.group-header')]
    .filter((h) => {
      const p = h.dataset.page;
      return p && p !== '(페이지 불명)' && p !== '(직접 추가)' && p !== draggingPage;
    });
  if (headers.length === 0) return null;
  // 가장 위 헤더보다 위에 있으면 그 헤더의 above
  const firstRect = headers[0].getBoundingClientRect();
  if (clientY < firstRect.top + firstRect.height / 2) {
    return { header: headers[0], above: true };
  }
  // 가장 아래 헤더보다 아래에 있으면 그 헤더의 below
  const lastRect = headers[headers.length - 1].getBoundingClientRect();
  if (clientY >= lastRect.top + lastRect.height / 2) {
    return { header: headers[headers.length - 1], above: false };
  }
  // 중간: 각 헤더 중심선 기준 가장 가까운 것
  let best = headers[0];
  let bestDist = Infinity;
  for (const h of headers) {
    const r = h.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const d = Math.abs(clientY - mid);
    if (d < bestDist) { bestDist = d; best = h; }
  }
  const rect = best.getBoundingClientRect();
  return { header: best, above: clientY < rect.top + rect.height / 2 };
}

function setupListDragDelegation() {
  els.capturedList.addEventListener('dragover', (e) => {
    if (!draggingPage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = findDropTarget(e.clientY);
    if (!target) return;
    const targetPage = target.header.dataset.page;
    // 이미 같은 위치면 재삽입 안 함 (애니메이션 깜빡임 방지)
    if (dropPlaceholderEl &&
        dropPlaceholderEl.dataset.targetPage === targetPage &&
        dropPlaceholderAbove === target.above) {
      return;
    }
    clearDropPlaceholder();
    dropPlaceholderEl = document.createElement('li');
    dropPlaceholderEl.className = 'drop-placeholder';
    dropPlaceholderEl.dataset.targetPage = targetPage;
    dropPlaceholderAbove = target.above;
    target.header.classList.add('drop-target');
    // placeholder는 항상 "그룹 사이"에 위치하도록 — 헤더와 안 겹치게 그룹 영역 끝/시작에 둠
    const insertBefore = target.above
      ? target.header                            // above: target 그룹 시작 직전 (= 이전 그룹 마지막 행 뒤)
      : findGroupEndAnchor(target.header);       // below: target 그룹 마지막 노드 뒤 (= 다음 헤더 직전, 또는 끝)
    target.header.parentNode.insertBefore(dropPlaceholderEl, insertBefore);
  });
  els.capturedList.addEventListener('drop', async (e) => {
    if (!draggingPage) return;
    e.preventDefault();
    const src = draggingPage;
    const target = findDropTarget(e.clientY);
    clearDropPlaceholder();
    if (!target || target.header.dataset.page === src) return;
    const targetPage = target.header.dataset.page;
    const currentOrder = [...els.capturedList.querySelectorAll('li.group-header')]
      .map((h) => h.dataset.page)
      .filter((p) => p && p !== '(페이지 불명)' && p !== '(직접 추가)');
    const without = currentOrder.filter((p) => p !== src);
    const targetIdx = without.indexOf(targetPage);
    const insertAt = target.above ? targetIdx : targetIdx + 1;
    without.splice(insertAt, 0, src);
    pageOrder[selectedOrigin] = without;
    await chrome.storage.local.set({ [PAGE_ORDER_KEY]: pageOrder });
    renderCurrent();
  });
}

function renderGrouped(calls) {
  // 페이지별로 분류. 한 call이 여러 페이지에 속하면 모든 그룹에 나타남.
  const groups = new Map(); // page → Call[]
  for (const call of calls) {
    const pages = call.isCustom
      ? ['(직접 추가)']
      : (call.pages && call.pages.length > 0) ? call.pages : ['(페이지 불명)'];
    for (const p of pages) {
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(call);
    }
  }
  const collapsedSet = new Set(collapsedGroups[selectedOrigin] || []);
  // 페이지 순서: 사용자 지정 순서 우선, 그 외는 알파벳순으로 뒤에
  const allPages = [...groups.keys()];
  const savedOrder = pageOrder[selectedOrigin] || [];
  const orderedPages = [];
  const seen = new Set();
  for (const p of savedOrder) {
    if (groups.has(p) && !seen.has(p)) { orderedPages.push(p); seen.add(p); }
  }
  for (const p of allPages.sort()) {
    if (!seen.has(p)) { orderedPages.push(p); seen.add(p); }
  }
  const pages = orderedPages;
  for (const page of pages) {
    const headerNode = els.groupHeaderTpl.content.cloneNode(true);
    const header = headerNode.querySelector('li');
    header.dataset.page = page;
    header.querySelector('.group-label').textContent = page;
    header.querySelector('.group-count').textContent = `${groups.get(page).length} 개`;
    const isCollapsed = collapsedSet.has(page);
    if (isCollapsed) header.classList.add('collapsed');
    // 드래그로 그룹 순서 조정. (페이지 불명)/(직접 추가)는 가상 그룹이라 제외.
    if (page !== '(페이지 불명)' && page !== '(직접 추가)') {
      header.draggable = true;
      attachGroupDragHandlers(header, page);
    }

    const noteEl = header.querySelector('.group-note');
    if (page === '(페이지 불명)' || page === '(직접 추가)') {
      noteEl.remove();
    } else {
      getPageNote(selectedOrigin, page).then((note) => { noteEl.value = note; });
      let debounce = null;
      noteEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          setPageNote(selectedOrigin, page, noteEl.value);
        }, 400);
      });
      // 메모 입력 클릭은 토글 이벤트 안 받게
      noteEl.addEventListener('click', (e) => e.stopPropagation());
      // 포커스가 빠지는 시점에 보류된 리렌더 처리
      noteEl.addEventListener('blur', flushPendingRender);
    }

    // 🗑 페이지 기록 비우기: (페이지 불명)/(직접 추가) 그룹에는 무의미하니 제거
    const purgeBtn = header.querySelector('.group-purge');
    if (purgeBtn) {
      if (page === '(페이지 불명)' || page === '(직접 추가)') {
        purgeBtn.remove();
      } else {
        purgeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const count = groups.get(page).length;
          if (!confirm(`'${page}' 그룹의 ${count}개 항목을 비웁니다.\n다른 페이지에서도 호출되는 API는 그 페이지 그룹에 남습니다.\n계속할까요?`)) return;
          await chrome.runtime.sendMessage({
            type: 'removePageFromOrigin',
            origin: selectedOrigin,
            page,
          });
          // storage onChanged 리스너가 자동으로 리렌더함
        });
      }
    }

    // 헤더 클릭 → 접기/펼치기 토글
    header.addEventListener('click', () => {
      if (header.dataset.dragJustEnded) return; // 드래그 직후의 click은 무시
      const nowCollapsed = !header.classList.contains('collapsed');
      header.classList.toggle('collapsed', nowCollapsed);
      // 다음 그룹 헤더 전까지의 .row 들 토글
      let sibling = header.nextElementSibling;
      while (sibling && !sibling.classList.contains('group-header')) {
        sibling.hidden = nowCollapsed;
        sibling = sibling.nextElementSibling;
      }
      // 영속화
      const cur = new Set(collapsedGroups[selectedOrigin] || []);
      if (nowCollapsed) cur.add(page); else cur.delete(page);
      collapsedGroups[selectedOrigin] = [...cur];
      chrome.storage.local.set({ [COLLAPSED_GROUPS_KEY]: collapsedGroups });
    });

    els.capturedList.appendChild(headerNode);
    for (const call of groups.get(page)) {
      const before = els.capturedList.children.length;
      appendCallRow(call);
      // 접힌 그룹이면 방금 추가된 행 숨김
      if (isCollapsed) {
        const justAdded = els.capturedList.children[before];
        if (justAdded) justAdded.hidden = true;
      }
    }
  }
}

function appendCallRow(call) {
  const node = els.callRowTpl.content.cloneNode(true);
  const li = node.querySelector('li');
  li.dataset.rowKey = `${call.method} ${call.url}`;
  const methodEl = li.querySelector('.method');
  li.querySelector('.method-text').textContent = call.method;
  const urlEl = li.querySelector('.url');
  urlEl.textContent = call.url;
  urlEl.dataset.tip = call.url;
  const statusEl = li.querySelector('.status');
  statusEl.textContent = call.lastStatus ?? '-';
  if (call.lastStatus >= 200 && call.lastStatus < 300) statusEl.classList.add('ok');
  else if (call.lastStatus === 401 || call.lastStatus === 403) statusEl.classList.add('auth');
  else statusEl.classList.add('err');
  // 상태 배지 클릭 → 해당 URL을 새 탭에서 열어 응답 확인
  statusEl.dataset.tip = '새 탭에서 열기';
  statusEl.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.tabs.create({ url: call.url });
  });
  const metaEl = li.querySelector('.meta');
  // N회 = 이 API가 호출된 서로 다른 페이지 수. 단일 페이지면 의미 없어서 생략.
  const pageCount = Array.isArray(call.pages) ? call.pages.length : 0;
  const renderMeta = () => {
    // 자연 호출 시간 옆에 회수 같이. verdict 모드에선 meta 비우고 verdict가 ms·회 합쳐 표시.
    const parts = [`${call.lastDurationMs ?? 0}ms`];
    if (pageCount >= 2) parts.push(`${pageCount}회`);
    metaEl.textContent = parts.join('·');
  };
  renderMeta();
  if (pageCount >= 2) metaEl.classList.add('multi-page');

  const verdictEl = li.querySelector('.verdict');
  const replayBtn = li.querySelector('.replay');

  const applyVerdictVisual = (verdict, durationMs) => {
    // 버튼 색 — 검증 결과별
    replayBtn.classList.remove('v-monitorable', 'v-authRequired', 'v-error');
    if (verdict === 'monitorable') replayBtn.classList.add('v-monitorable');
    else if (verdict === 'authRequired') replayBtn.classList.add('v-authRequired');
    else if (verdict === 'error') replayBtn.classList.add('v-error');
    // 메타 자리에 결과 표시 — ms·회는 verdict로 대체. 페이지 수는 verdict 텍스트에 합쳐서 위치 유지.
    if (verdict) {
      const base = verdict === 'monitorable' ? `✅ ${durationMs}ms`
        : verdict === 'authRequired' ? '🔒 인증'
        : verdict === 'error' ? '⚠️ 에러'
        : `❔ ${durationMs}ms`;
      verdictEl.textContent = pageCount >= 2 ? `${base}·${pageCount}회` : base;
      verdictEl.className = `verdict ${verdict}`;
      metaEl.textContent = '';
    }
  };
  // 이전 검증 결과가 있으면 처음부터 적용
  if (call.lastVerdict) applyVerdictVisual(call.lastVerdict, call.lastVerdictMs);

  replayBtn.addEventListener('click', async () => {
    replayBtn.disabled = true;
    verdictEl.textContent = '검증중…';
    verdictEl.className = 'verdict';
    metaEl.textContent = '';
    const res = await chrome.runtime.sendMessage({ type: 'replayNaked', url: call.url });
    replayBtn.disabled = false;
    const verdict = (!res || res.verdict === 'error') ? 'error' : res.verdict;
    const durationMs = res?.durationMs ?? 0;
    applyVerdictVisual(verdict, durationMs);
    if (verdict === 'error') verdictEl.title = res?.message ?? 'unknown';
    // 영속 저장 — 캡쳐된 행에만 의미 있음
    if (selectedOrigin) {
      chrome.runtime.sendMessage({
        type: 'updateVerdict',
        origin: selectedOrigin,
        method: call.method,
        url: call.url,
        verdict,
        durationMs,
      });
    }
  });

  const noteEl = li.querySelector('.note');
  noteEl.value = call.note || '';

  // 메모 토글 — 평소엔 숨김. 사용자가 ✎ 누를 때만 펼침.
  // 메모 내용 유무는 ✎ 버튼의 has-note 강조로만 표시 (자동으로 펼치지 않음).
  // 직접 추가 행은 같은 패널에서 삭제 링크도 노출.
  const rowBottom = li.querySelector('.row-bottom');
  const toggleNoteBtn = li.querySelector('.toggle-note');
  const rowKey = `${call.method} ${call.url}`;
  // 이전에 펼쳐져 있던 행이면 리렌더 후에도 펼친 상태 복원
  if (expandedRows.has(rowKey)) rowBottom.hidden = false;

  const updateToggleVisual = () => {
    const hasNote = !!noteEl.value.trim();
    toggleNoteBtn.classList.toggle('has-note', hasNote);
  };
  updateToggleVisual();
  toggleNoteBtn.addEventListener('click', () => {
    rowBottom.hidden = !rowBottom.hidden;
    if (rowBottom.hidden) expandedRows.delete(rowKey);
    else { expandedRows.add(rowKey); noteEl.focus(); }
  });
  // 포커스가 빠지는 시점에 보류된 리렌더 처리
  noteEl.addEventListener('blur', flushPendingRender);
  let noteDebounce = null;
  noteEl.addEventListener('input', () => {
    updateToggleVisual();
    clearTimeout(noteDebounce);
    noteDebounce = setTimeout(async () => {
      // 자기가 일으킨 storage 변경의 리렌더는 onChanged에서 1회 무시
      if (call.isCustom) {
        suppressNextCustomUrlsChange = true;
        await updateCustomUrlNote(selectedOrigin, call.url, noteEl.value);
      } else {
        suppressNextCapturesChange = true;
        await chrome.runtime.sendMessage({
          type: 'updateNote',
          origin: selectedOrigin,
          method: call.method,
          url: call.url,
          note: noteEl.value,
        });
      }
      call.note = noteEl.value;
      const fav = favorites.find((f) => f.method === call.method && f.url === call.url);
      if (fav) {
        favorites = await updateFavorite(call.method, call.url, { note: noteEl.value });
      }
    }, 400);
  });

  // 삭제 링크 — 모든 행에서 활성. 행 종류에 따라 동작 다름.
  const delLink = li.querySelector('.delete-custom');
  delLink.hidden = false;
  delLink.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm(`이 URL을 삭제할까요?\n\n${call.url}`)) return;
    if (call.isCustom) {
      await removeCustomUrl(selectedOrigin, call.url);
      await refreshCustomUrls();
    } else {
      await chrome.runtime.sendMessage({
        type: 'removeCall',
        origin: selectedOrigin,
        method: call.method,
        url: call.url,
      });
      // 캡쳐 onChanged 가 reloadCaptures 호출 → render
    }
    if (favorites.some((f) => f.method === call.method && f.url === call.url)) {
      favorites = await removeFavorite(call.method, call.url);
    }
    renderCurrent();
  });

  urlEl.addEventListener('click', () => copyUrl(call.url, urlEl));

  const starMark = methodEl.querySelector('.star-mark');
  const updateFavVisual = (favored) => {
    methodEl.classList.toggle('favorited', favored);
    starMark.textContent = favored ? '★' : '☆';
    methodEl.dataset.tip = favored ? '즐겨찾기 해제' : '즐겨찾기';
  };
  updateFavVisual(favorites.some((f) => f.method === call.method && f.url === call.url));

  methodEl.addEventListener('click', async () => {
    const exists = favorites.find((f) => f.method === call.method && f.url === call.url);
    if (exists) {
      favorites = await removeFavorite(call.method, call.url);
      updateFavVisual(false);
    } else {
      favorites = await saveFavorite({
        method: call.method,
        url: call.url,
        note: call.note || '',
        pages: call.pages || [],
      });
      updateFavVisual(true);
    }
  });

  els.capturedList.appendChild(node);
}

// renderFavorites는 renderRows(.., favoritesOnly=true) 로 통합됨.

let currentExport = null; // { title, json, filename }

function openExportModal(title, endpoints, filenamePrefix) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    endpoints,
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = `${filenamePrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  currentExport = { title, json, filename };

  els.exportModalTitle.textContent = title;
  els.exportPreview.textContent = json;
  els.exportSummary.textContent = `${endpoints.length}개 endpoint · ${json.length.toLocaleString()}자`;
  els.exportModal.classList.remove('hidden');

  els.exportCopyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(json);
      showToast(els.exportCopyBtn, '✓ 클립보드로 복사됨');
    } catch (err) {
      showToast(els.exportCopyBtn, '복사 실패', true);
    }
  };
  els.exportDownloadBtn.onclick = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    closeExportModal();
  };
}

function closeExportModal() {
  els.exportModal.classList.add('hidden');
  currentExport = null;
}

async function addCustomFavorite() {
  const url = els.favAddUrl.value.trim();
  if (!url) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    alert('올바른 URL 형식이 아닙니다. (예: https://api.example.com/v2/foo)');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    alert('URL은 http:// 또는 https:// 로 시작해야 합니다.');
    return;
  }
  if (!selectedOrigin) {
    alert('먼저 위 도메인 드롭다운에서 추가할 도메인을 선택하세요.');
    return;
  }
  if (parsed.origin !== selectedOrigin) {
    alert(`이 URL의 도메인(${parsed.origin})이 현재 선택된 도메인(${selectedOrigin})과 다릅니다.\n같은 도메인의 URL만 추가할 수 있습니다.`);
    return;
  }
  if (customUrls.some((c) => c.url === url)) {
    alert('이미 추가된 URL입니다.');
    return;
  }
  els.favAddBtn.disabled = true;
  try {
    await addCustomUrl(selectedOrigin, url);
    els.favAddUrl.value = '';
    await refreshCustomUrls();
    renderCurrent();
  } finally {
    els.favAddBtn.disabled = false;
  }
}

async function copyUrl(url, urlEl) {
  try {
    await navigator.clipboard.writeText(url);
    showToast(urlEl, '✓ 복사됨');
  } catch (err) {
    showToast(urlEl, '복사 실패', true);
  }
}

// 스낵바 — 상단 중앙에 잠시 표시되는 알림.
let activeSnackbar = null;
function showToast(_anchorEl, text, isError = false) {
  if (activeSnackbar) activeSnackbar.remove();
  const snack = document.createElement('div');
  snack.className = 'snackbar';
  if (isError) snack.classList.add('error');
  snack.textContent = text;
  document.body.appendChild(snack);
  activeSnackbar = snack;
  // 다음 프레임에 visible 클래스 부여 → fade-in
  requestAnimationFrame(() => snack.classList.add('visible'));
  setTimeout(() => {
    snack.classList.remove('visible');
    setTimeout(() => {
      if (snack.parentNode) snack.remove();
      if (activeSnackbar === snack) activeSnackbar = null;
    }, 200);
  }, 1500);
}

function formatBytes(n) {
  if (!n) return '-';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// Floating 툴팁 — body에 단 한 개의 .floating-tip을 두고, mouseover 위임으로 위치 갱신.
// pseudo-element 방식은 부모의 overflow:hidden 에 잘려서 못 씀.
(function setupFloatingTooltip() {
  const tip = document.createElement('div');
  tip.className = 'floating-tip';
  tip.style.display = 'none';
  document.body.appendChild(tip);

  let currentTarget = null;

  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    tip.style.display = '';

    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    // 기본: 아래쪽으로
    let top = rect.bottom + 4;
    let left = rect.left;
    // 우측 잘림 보정
    if (left + tipRect.width > window.innerWidth - 4) {
      left = window.innerWidth - tipRect.width - 4;
    }
    if (left < 4) left = 4;
    // 하단 잘림 시 위로 띄우기
    if (top + tipRect.height > window.innerHeight - 4) {
      top = rect.top - tipRect.height - 4;
    }
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }

  function hide() {
    tip.style.display = 'none';
    currentTarget = null;
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (target === currentTarget) return;
    if (target) {
      currentTarget = target;
      show(target);
    } else {
      hide();
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (!currentTarget) return;
    // 자식 사이 이동은 무시 (currentTarget 안에 머무는 경우)
    if (currentTarget.contains(e.relatedTarget)) return;
    hide();
  });
  document.addEventListener('scroll', hide, true);
  // 동적으로 data-tip 텍스트가 바뀌면 현재 표시중일 때 갱신
  const observer = new MutationObserver(() => {
    if (currentTarget && document.body.contains(currentTarget)) {
      show(currentTarget);
    } else {
      hide();
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-tip'], subtree: true });
})();

init();
