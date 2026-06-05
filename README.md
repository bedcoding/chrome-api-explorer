# API Explorer

페이지에서 호출되는 **GET API**를 자동 감지해서 헬스체크 모니터링 대상으로 골라내는 크롬 확장. 바닐라 JS, 빌드 없음.

## 설치

1. Chrome → `chrome://extensions` → **개발자 모드** ON
2. **"압축해제된 확장 프로그램을 로드"** → 이 폴더(`api-explorer`) 선택
3. 시크릿창에서 쓰려면 확장 상세 → **"시크릿 모드에서 허용"** ON

> 사이드패널은 페이지를 옮겨다녀도 닫히지 않습니다.
> 모든 데이터는 `chrome.storage.local` 에 영속 저장돼 브라우저를 껐다 켜도 유지됩니다.

## UI 한눈에

```
[ API Explorer                        ★ 즐겨찾기만 ]   ← 토글 ON 시 즐겨찾기만 표시

[ ✓ 감지 ON  ✓ 페이지별 그룹화        ⚙ ]

도메인   [ example.com (수집 화이트리스트) ]
검색     [ URL/메모 검색 (정규식)         ]
그룹     [ https://www.example.com (30) ▾ ] [노이즈] [⌫]

────────────────────────────────────────────
URL 직접 추가                            [★ 추가]
────────────────────────────────────────────

▼ /            16개   [이 페이지의 용도]
  ☆ GET  검증  https://...api/time           23ms·9회 [200]
  ☆ GET  검증  https://...api/banner    ✎    178ms·1회 [200]
▼ /ranking      6개
  ★ GET  검증  https://...api/list      ✎    ✅142ms  [200]
```

- **GET 배지** = 클릭 시 즐겨찾기 토글 (☆ ↔ ★ 노란색)
- **검증 버튼** = 헤더/쿠키 빼고 재호출. 결과별로 버튼 색 변함 (녹색/노랑/빨강)
- **URL** = 클릭하면 클립보드 복사
- **✎** = 메모 펼침. 메모 입력 + URL 삭제 버튼

## 표준 시나리오

대상 사이트에서 헬스체크 후보 API를 골라 정리하는 흐름.

### 0. 사전 1회 세팅

1. 툴바 확장 아이콘 클릭 → 사이드패널 열림
2. **"도메인"** 칸에 대상 도메인 입력 (예: `example.com`) — 자동 저장
   - suffix 매칭이라 `example.com` 하나면 `www.example.com`, `api.example.com` 다 통과
   - 비어두면 모든 도메인 캡쳐 (노이즈 잡탕 됨, 비추)

### 1. 감지 시작

1. 시크릿창으로 대상 사이트 진입 (비로그인 = 모니터링 환경과 동일)
2. 사이드패널 상단 **감지 ON** 체크
3. 페이지 **새로고침 (F5)**
   - 토글 켜기 전에 로드된 호출은 못 잡힘. 켠 다음 새로고침해야 첫 로딩 API까지 잡힘.

### 2. 메뉴 순회

홈 → 각 메뉴 순서로 클릭. 각 메뉴 진입 시 호출되는 API는 현재 페이지 path와 함께 저장됨.
같은 API가 여러 메뉴에서 호출되면 `pages: ["/", "/ranking"]` 처럼 자동 누적.

> 메뉴 이동 시 새로고침 불필요. SPA 라우팅 호출도 자동 캡쳐됨.

### 3. 사이드패널에서 정리

- **그룹** 드롭다운: 사이트가 여러 origin을 호출하면(예: `api.*`, `cdn.*`, `recommend.*`) 다 보임. 헬스체크 대상은 보통 `api.*`
- **페이지별 그룹화** 체크: 메뉴별 그룹 헤더로 묶임. 각 그룹 헤더는 클릭으로 접기/펼치기, 옆에 페이지 용도 메모 입력 가능
- **검색**: URL이나 메모 내용에서 정규식 매칭
- **노이즈** 버튼: 도메인 화이트리스트 밖 그룹을 일괄 삭제 (캡쳐 + 직접 추가 둘 다)
- **⌫**: 현재 선택된 그룹의 캡쳐 + 직접 추가 모두 삭제

### 4. 모니터링 후보 선별

각 행에서:
- **GET 배지 클릭** → 즐겨찾기 토글 (☆ → ★ 노란색)
- **검증 버튼** → 헤더/쿠키 빼고 재호출 → ✅(모니터링 가능) / 🔒(인증 필요) / ⚠️(에러)
  - 결과는 영속화되어 새로고침해도 유지. 버튼 색깔로 검증 완료 표시.
- **✎ 메모 펼침** → 이 API 전용 메모 입력 + 직접 추가 항목 URL 삭제 가능

추리는 기준:
- ✅ 모니터링 가능 (비로그인 200)
- 여러 페이지에서 호출됨 (`pages` 다수, `hitCount` 높음) → 핵심 경로
- 응답시간 빠름 (모니터링 부하 적음)

### 5. 대표 URL 직접 추가 (옵션)

같은 path에 query만 다른 API가 많을 때(`?name=A`, `?name=B`, ...) 쿼리 잘라낸 **대표 URL**을 직접 추가:
- 상단 **URL 직접 추가** 박스에 입력 → **★ 추가**
- 현재 선택된 그룹과 같은 origin만 받음 (다르면 알림)
- 별도 그룹 **(직접 추가)** 아래에 표시됨
- 메모/즐겨찾기/검증 다 일반 행과 동일하게 동작
- ✎ → 🗑 **URL 삭제** 링크로 제거

### 6. Export

하단 두 버튼:
- **★ Export**: 즐겨찾기(★)만 JSON으로
- **전체 Export**: 현재 그룹의 모든 API(★ 무관)

둘 다 누르면 모달이 뜨면서 JSON 미리보기 + 두 옵션:
- **클립보드 복사** — 파일 안 받고 바로 복사
- **파일 다운로드** — 일반 다운로드

이후 `api-monitor` 맥북앱에 import.

## 자주 헷갈리는 점

| 증상 | 원인 / 해결 |
|---|---|
| 페이지 첫 로딩 API가 안 잡힘 | 감지 토글 켠 다음 **새로고침** 해야 함 |
| 페이지 path가 `(페이지 불명)` 으로 보임 | 라우팅 직후 호출이 너무 빨라 path 추적이 늦은 경우. 메뉴 클릭 후 1초쯤 기다렸다 다음으로 이동 |
| 그룹 드롭다운에 여러 origin이 뜸 | 사이트가 여러 호스트를 호출. 헬스체크 대상은 보통 `api.*` 같은 명확한 호스트 |
| 시크릿창에서 확장이 안 보임 | `chrome://extensions` → 본 확장 "상세" → "시크릿 모드에서 허용" ON |
| ★ 노란별 안 보임 | GET 배지 자체를 클릭해야 함 (배지 좌측의 ☆/★) |

## 폴더 구조

```
manifest.json              MV3 매니페스트
background/
  service-worker.js        webRequest 캡쳐 + 영속화 + 재호출 + 메시지 라우팅
sidepanel/
  sidepanel.{html,css,js}  메인 UI (그룹 선택, API 리스트, 검증, 메모, export 등 전부)
options/
  options.{html,css,js}    수집 도메인 / 저장 데이터 관리 (대부분 기능은 사이드패널에 있음)
shared/
  captures.js              영속 캡쳐 저장소 (origin → method+url 키)
  custom-urls.js           사용자가 직접 추가한 URL 저장소 (origin 별 묶음)
  page-notes.js            페이지(path) 단위 메모 저장소
  storage.js               즐겨찾기 + JSON export 유틸
  settings.js              감지 토글 / 도메인 화이트리스트
  filter.js                정규식 매칭 (검색용)
```

## 작동 원리

- `chrome.webRequest.onCompleted` 가 모든 탭의 GET 호출 가로챔 (`xmlhttprequest` + `other` 타입)
- **감지 OFF** 거나 **도메인 화이트리스트 밖** 이면 무시
- 통과한 호출은 `chrome.storage.local.captures_v1` 에 `origin → method+url` 키로 누적
  - 같은 API가 N번 호출되면 `hitCount` 증가, `lastStatus`/`lastDurationMs` 갱신
  - 호출 발생한 페이지 path를 `pages` 배열에 누적
- 사이드패널은 `storage.onChanged` 를 들어 실시간 갱신
- **검증** 버튼: `fetch(url, { credentials: 'omit' })` 으로 헤더 없이 재호출
  - 결과를 `lastVerdict` 로 영속 저장 → 새로고침 후에도 버튼 색 유지

## 한계

- **응답 body 캡쳐 불가** (MV3 webRequest 제약). 필요하면 DevTools Network 탭 직접 사용.
- **POST/PUT은 캡쳐 안 함**. 헬스체크는 GET이 본질이라 의도적으로 제외.
- 화이트리스트는 `chrome.webRequest` 의 호스트 매칭이 아니라 사용자 코드에서 거름 — 광고 트래커 도메인이 잠시 들어왔다 무시되는 형태.

## 데이터 모델

**캡쳐 (영속)**
```js
// chrome.storage.local.captures_v1
{
  "https://api.example.com": {
    "GET https://api.example.com/v2/foo": {
      method: "GET",
      url: "https://api.example.com/v2/foo",
      lastStatus: 200,
      lastDurationMs: 142,
      lastSizeBytes: 5320,
      firstSeenAt: 1717564800000,
      lastSeenAt: 1717566000000,
      hitCount: 5,
      pages: ["/", "/ranking"],
      note: "홈 메인 데이터",
      lastVerdict: "monitorable",   // 검증 결과 (있을 때만)
      lastVerdictMs: 131,
      lastVerdictAt: 1717566100000
    }
  }
}
```

**직접 추가 URL**
```js
// chrome.storage.local.customUrls_v1
{
  "https://api.example.com": [
    { method: "GET", url: "https://api.example.com/v2/foo", note: "", addedAt: ... }
  ]
}
```

**즐겨찾기**
```js
// chrome.storage.local.favorites_v1
[
  { method: "GET", url: "https://...", note: "", pages: ["/", "/ranking"] }
]
```

**JSON Export 포맷** (`api-monitor` 와 합의)
```json
{
  "version": 1,
  "exportedAt": "2026-06-05T...",
  "endpoints": [
    {
      "method": "GET",
      "url": "https://api.example.com/v2/foo",
      "note": "홈 메인 데이터",
      "pages": ["/", "/ranking"]
    }
  ]
}
```
