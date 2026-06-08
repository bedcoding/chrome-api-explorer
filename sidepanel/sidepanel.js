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
  toggleAllNotesBtn: document.getElementById('toggleAllNotesBtn'),
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

let collapsedGroups = {}; // 현재 origin의 접힌 페이지 Set

// 메모/검색 input에 포커스가 있을 때 리렌더가 일어나면 input 노드가 교체돼
// 포커스가 사라진다. 포커스 중에는 리렌더를 큐잉했다가 blur 시 1회 실행한다.
let pendingRender = false;
function isTypingInEditableInput() {
  const a = document.activeElement;
  if (!a) return false;
  return a.matches?.('.note, .group-note, #filterInput, #whitelistInput, #favAddUrl');
}

async function init() {
  // 마지막 선택 도메인 복원 — 활성 탭 origin보다 우선
  const stored = await chrome.storage.local.get([LAST_ORIGIN_KEY, GROUP_BY_PAGE_KEY, COLLAPSED_GROUPS_KEY, FAV_ONLY_KEY]);
  if (stored[LAST_ORIGIN_KEY]) selectedOrigin = stored[LAST_ORIGIN_KEY];
  groupByPage = !!stored[GROUP_BY_PAGE_KEY];
  els.groupToggle.checked = groupByPage;
  collapsedGroups = stored[COLLAPSED_GROUPS_KEY] || {};
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

  // Export 드롭업: 트리거 클릭으로 토글, 메뉴 바깥 클릭으로 닫기
  els.exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.exportMenu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!els.exportMenu.contains(e.target)) els.exportMenu.classList.remove('open');
  });

  els.exportFavBtn.addEventListener('click', () => {
    els.exportMenu.classList.remove('open');
    if (favorites.length === 0) {
      alert('즐겨찾기가 비어있습니다.\nGET 배지(☆)를 클릭해 추가하거나 "전체"로 내보내세요.');
      return;
    }
    const endpoints = favorites.map((f) => ({
      method: f.method,
      url: f.url,
      note: f.note || '',
      pages: f.pages || [],
    }));
    openExportModal('★ 즐겨찾기 Export', endpoints, 'api-explorer-favorites');
  });

  // 메모 일괄 토글: 펼침 시 메모 내용이 있는 행만 펼치고, 접힘 시 전부 접는다.
  let allNotesExpanded = false;
  els.toggleAllNotesBtn.addEventListener('click', () => {
    allNotesExpanded = !allNotesExpanded;
    els.toggleAllNotesBtn.textContent = allNotesExpanded ? '메모 접기' : '메모 펼치기';
    for (const li of els.capturedList.querySelectorAll('li.row')) {
      const rb = li.querySelector('.row-bottom');
      const noteEl = li.querySelector('.note');
      if (!rb) continue;
      if (allNotesExpanded) {
        // 메모 내용이 있는 행만 펼침
        rb.hidden = !(noteEl && noteEl.value.trim());
      } else {
        rb.hidden = true;
      }
    }
  });

  els.exportAllBtn.addEventListener('click', () => {
    els.exportMenu.classList.remove('open');
    if (currentCalls.length === 0) {
      alert('현재 선택된 도메인에 캡쳐된 API가 없습니다.');
      return;
    }
    const endpoints = currentCalls.map((c) => ({
      method: c.method,
      url: c.url,
      note: c.note || '',
      pages: c.pages || [],
    }));
    const prefix = `api-explorer-all-${hostnameOf(selectedOrigin) || 'unknown'}`;
    openExportModal(`전체 Export — ${hostnameOf(selectedOrigin) || ''}`, endpoints, prefix);
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
      allCaptures = changes.captures_v1.newValue ?? {};
      populateOriginSelect();
      pickCurrentCalls();
      renderCurrent();
      updateCounter();
    }
    if ('favorites_v1' in changes) {
      favorites = changes.favorites_v1.newValue ?? [];
      renderCurrent();
    }
    if ('allowDomains_v1' in changes) {
      refreshWhitelistView();
    }
    if ('customUrls_v1' in changes) {
      refreshCustomUrls().then(renderCurrent);
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

function updateCounter() {
  const totalOrigins = Object.keys(allCaptures).length;
  let totalCalls = 0;
  for (const o of Object.values(allCaptures)) totalCalls += Object.keys(o).length;
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
  const pages = [...groups.keys()].sort();
  for (const page of pages) {
    const headerNode = els.groupHeaderTpl.content.cloneNode(true);
    const header = headerNode.querySelector('li');
    header.querySelector('.group-label').textContent = page;
    header.querySelector('.group-count').textContent = `${groups.get(page).length} 개`;
    const isCollapsed = collapsedSet.has(page);
    if (isCollapsed) header.classList.add('collapsed');

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

    // 헤더 클릭 → 접기/펼치기 토글
    header.addEventListener('click', () => {
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
  const metaParts = [`${call.lastDurationMs ?? 0}ms`];
  metaParts.push(`${call.hitCount ?? 1}회`);
  metaEl.textContent = metaParts.join('·');

  const verdictEl = li.querySelector('.verdict');
  const replayBtn = li.querySelector('.replay');

  const applyVerdictVisual = (verdict, durationMs) => {
    // 버튼 색 — 검증 결과별
    replayBtn.classList.remove('v-monitorable', 'v-authRequired', 'v-error');
    if (verdict === 'monitorable') replayBtn.classList.add('v-monitorable');
    else if (verdict === 'authRequired') replayBtn.classList.add('v-authRequired');
    else if (verdict === 'error') replayBtn.classList.add('v-error');
    // 메타 자리에 결과 표시
    if (verdict) {
      const text = verdict === 'monitorable' ? `✅ ${durationMs}ms`
        : verdict === 'authRequired' ? '🔒 인증'
        : verdict === 'error' ? '⚠️ 에러'
        : `❔ ${durationMs}ms`;
      verdictEl.textContent = text;
      verdictEl.className = `verdict ${verdict}`;
      metaEl.style.display = 'none';
    }
  };
  // 이전 검증 결과가 있으면 처음부터 적용
  if (call.lastVerdict) applyVerdictVisual(call.lastVerdict, call.lastVerdictMs);

  replayBtn.addEventListener('click', async () => {
    replayBtn.disabled = true;
    verdictEl.textContent = '검증중…';
    verdictEl.className = 'verdict';
    metaEl.style.display = 'none';
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
  const updateToggleVisual = () => {
    const hasNote = !!noteEl.value.trim();
    toggleNoteBtn.classList.toggle('has-note', hasNote);
  };
  updateToggleVisual();
  toggleNoteBtn.addEventListener('click', () => {
    rowBottom.hidden = !rowBottom.hidden;
    if (!rowBottom.hidden) noteEl.focus();
  });
  // 포커스가 빠지는 시점에 보류된 리렌더 처리
  noteEl.addEventListener('blur', flushPendingRender);
  let noteDebounce = null;
  noteEl.addEventListener('input', () => {
    updateToggleVisual();
    clearTimeout(noteDebounce);
    noteDebounce = setTimeout(async () => {
      if (call.isCustom) {
        // 직접 추가 항목은 customUrls 저장소에 저장
        await updateCustomUrlNote(selectedOrigin, call.url, noteEl.value);
      } else {
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
