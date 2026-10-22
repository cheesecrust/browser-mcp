# browser-mcp

AI 에이전트(Claude Code, Claude Desktop, Cursor 등)가 **실제 브라우저를 직접 조작**할 수 있게 해주는
[MCP(Model Context Protocol)](https://modelcontextprotocol.io) 서버입니다. 내부적으로 [Playwright](https://playwright.dev)를 사용합니다.

- 페이지를 열고, 접근성 트리 **스냅샷**(각 요소에 `[ref=e12]` 같은 id가 붙음)을 읽은 뒤, ref로 클릭/입력/선택
- 모든 액션이 **변경된 페이지 스냅샷을 함께 반환**하므로 왕복 횟수가 적음
- 스크린샷, 텍스트 추출, JavaScript 실행, 탭 관리, 다이얼로그 처리, 콘솔/네트워크 로그 조회
- 헤드리스/헤디드, Chromium/Firefox/WebKit, 설치된 Chrome 사용, 로그인 유지용 영속 프로필 지원

## 요구 사항

- Node.js 20.11 이상
- Playwright 브라우저 바이너리 (아래 설치 명령 참고)

## 설치

```bash
cd /path/to/browser-mcp
npm install
npx playwright install chromium   # 처음 한 번 (Firefox/WebKit을 쓰려면 해당 브라우저도 설치)
npm run build
```

## 클라이언트에 등록하기

### Claude Code

```bash
# 모든 프로젝트에서 사용 (user scope)
claude mcp add --scope user browser -- node /path/to/browser-mcp/dist/index.js

# 창 없이(headless) 쓰고 싶다면
claude mcp add --scope user browser -- node /path/to/browser-mcp/dist/index.js --headless
```

프로젝트 공유용 `.mcp.json` 예시:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": { "BROWSER_MCP_HEADLESS": "false" }
    }
  }
}
```

### Claude Desktop / Cursor 등 (JSON 설정)

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/browser-mcp/dist/index.js", "--channel", "chrome"]
    }
  }
}
```

등록 후 "example.com에 들어가서 제목을 알려줘" 같은 요청을 하면 모델이 `browser_navigate` → 스냅샷 읽기 → `browser_click`/`browser_type` 순으로 도구를 호출합니다.

## 도구 목록

| 도구 | 설명 |
| --- | --- |
| `browser_navigate` | URL로 이동하고 스냅샷 반환 (첫 호출 시 브라우저 실행) |
| `browser_navigate_back` / `browser_navigate_forward` | 히스토리 뒤로/앞으로 |
| `browser_snapshot` | 접근성 스냅샷 (ref 포함). `ref`/`selector`로 범위 제한 가능 |
| `browser_screenshot` | 뷰포트/전체 페이지/요소 스크린샷을 이미지로 반환, `savePath`로 파일 저장 |
| `browser_get_text` | 페이지 또는 요소의 보이는 텍스트 (긴 텍스트는 `offset`으로 페이징) |
| `browser_evaluate` | 페이지에서 JavaScript 실행 (표현식 또는 함수, 요소를 인자로 받을 수 있음) |
| `browser_click` | ref/selector로 클릭 (우클릭, 더블클릭, 보조키 지원) |
| `browser_type` | 텍스트 입력 (`submit`으로 Enter, `slowly`로 한 글자씩, `clear:false`로 이어 쓰기) |
| `browser_press_key` | 키 입력 (`Enter`, `Tab`, `Control+a` 등) |
| `browser_hover` | 마우스 호버 |
| `browser_select_option` | `<select>`에서 값/라벨로 옵션 선택 |
| `browser_scroll` | 페이지 스크롤 또는 요소를 화면에 보이게 스크롤 |
| `browser_drag` | 드래그 앤 드롭 |
| `browser_file_upload` | `<input type="file">`에 파일 지정 |
| `browser_wait_for` | 텍스트 등장/사라짐, 셀렉터 상태, 로드 상태, 시간 대기 |
| `browser_handle_dialog` | alert/confirm/prompt 수락 또는 취소 |
| `browser_tabs` | 탭 목록/새 탭/전환/닫기 |
| `browser_resize` | 뷰포트 크기 변경 |
| `browser_console_messages` | 콘솔 출력과 처리되지 않은 에러 조회 |
| `browser_network_requests` | 네트워크 요청 목록 조회 |
| `browser_close` | 브라우저 종료 (다음 호출 시 자동 재실행) |

### 동작 방식 메모

- **ref**: 스냅샷의 `[ref=e12]`가 요소 id입니다(페이지 이동 후에는 `f3e12`처럼 프레임 접두사가 붙기도 하며, 보이는 그대로 쓰면 됩니다). 가장 최근 스냅샷의 ref만 유효하며, 모든 액션 결과에 새 스냅샷이 포함되므로 그 ref를 사용하면 됩니다.
- **selector**: ref가 없을 때 Playwright 셀렉터(CSS, `text=`, `role=`, `xpath=`)를 쓸 수 있습니다. 여러 요소에 매칭되면 Playwright의 strict 모드 에러가 후보 목록과 함께 반환됩니다.
- **다이얼로그**: `alert`/`confirm`/`prompt`가 뜨면 액션 결과에 표시되고, 처리 전까지 다른 액션은 거부됩니다. `browser_handle_dialog`로 처리하세요.
- **새 탭**: 팝업이 열리면 결과에 `New tab opened at index N`이 표시됩니다. `browser_tabs`의 `select`로 전환합니다.
- **긴 스냅샷**: 기본 30,000자에서 잘립니다(`--snapshot-max-chars`). 필요하면 `browser_snapshot`에 `selector`를 주거나 `browser_get_text`를 사용하세요.
- 도구 호출은 서버 안에서 **직렬화**되어 실행됩니다(동시에 두 액션이 한 페이지를 건드리지 않음).
- 다운로드는 자동으로 저장되며(`--downloads-dir`, 기본은 OS 임시 디렉터리) 서버 stderr 로그에 경로가 찍힙니다.

## 실행 옵션

모든 옵션은 CLI 플래그 또는 `BROWSER_MCP_*` 환경 변수로 지정할 수 있습니다(플래그 우선).

| 플래그 | 환경 변수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `--headless` / `--headed` | `BROWSER_MCP_HEADLESS` | headed | 창 표시 여부 |
| `--browser <name>` | `BROWSER_MCP_BROWSER` | `chromium` | `chromium` / `firefox` / `webkit` |
| `--channel <channel>` | `BROWSER_MCP_CHANNEL` | | 설치된 브라우저 사용: `chrome`, `msedge`, `chrome-beta` 등 |
| `--executable-path <path>` | `BROWSER_MCP_EXECUTABLE_PATH` | | 특정 브라우저 실행 파일 |
| `--user-data-dir <dir>` | `BROWSER_MCP_USER_DATA_DIR` | | 영속 프로필 디렉터리 (로그인/쿠키 유지) |
| `--storage-state <file>` | `BROWSER_MCP_STORAGE_STATE` | | Playwright storage state JSON 로드 |
| `--viewport <WxH>` | `BROWSER_MCP_VIEWPORT` | `1280x720` | 뷰포트 크기 |
| `--timeout <ms>` | `BROWSER_MCP_TIMEOUT` | `15000` | 요소 액션 타임아웃 |
| `--navigation-timeout <ms>` | `BROWSER_MCP_NAVIGATION_TIMEOUT` | `30000` | 페이지 이동 타임아웃 |
| `--user-agent <ua>` | `BROWSER_MCP_USER_AGENT` | | User-Agent 지정 |
| `--locale <locale>` | `BROWSER_MCP_LOCALE` | | 브라우저 로케일 (`ko-KR` 등) |
| `--ignore-https-errors` | `BROWSER_MCP_IGNORE_HTTPS_ERRORS` | off | 인증서 오류 무시 |
| `--snapshot-max-chars <n>` | `BROWSER_MCP_SNAPSHOT_MAX_CHARS` | `30000` | 스냅샷 최대 길이 |
| `--downloads-dir <dir>` | `BROWSER_MCP_DOWNLOADS_DIR` | OS temp | 다운로드 저장 위치 |
| `--proxy <url>` | `BROWSER_MCP_PROXY` | | 브라우저가 사용할 프록시 (`http://host:3128`, `socks5://host:1080`) |
| `--proxy-bypass <hosts>` | `BROWSER_MCP_PROXY_BYPASS` | | 프록시를 거치지 않을 호스트 (`localhost,*.internal`) |

예: 로그인 상태를 유지하면서 설치된 Chrome으로 실행

```bash
node dist/index.js --channel chrome --user-data-dir ~/.browser-mcp-profile
```

## 개발

```bash
npm run dev          # tsx로 소스 직접 실행 (stdio)
npm run build        # dist/ 로 컴파일
npm run typecheck    # 소스 + 테스트 타입 검사
npm test             # 빌드 후 헤드리스 Chromium으로 엔드투엔드 스모크 테스트
npm run inspector    # MCP Inspector로 도구를 직접 호출해 보기
```

`npm test`는 로컬 HTTP 픽스처 서버를 띄우고, MCP 클라이언트로 서버 프로세스를 실제로 spawn 해서
탐색·클릭·폼 입력·다이얼로그·탭·스크린샷·업로드 등 모든 도구를 검증합니다.

### 구조

```
src/
  index.ts          CLI 진입점, stdio 서빙, 종료 처리
  config.ts         플래그/환경 변수 파싱
  browser.ts        BrowserSession: 지연 실행, 탭, 다이얼로그, 콘솔/네트워크 로그
  snapshot.ts       접근성 스냅샷 + 페이지 설명 포맷
  server.ts         McpServer 생성과 도구 등록
  tools/
    common.ts       도구 등록 헬퍼, 직렬화 뮤텍스, 공통 결과 포맷
    navigation.ts   navigate / back / forward
    inspect.ts      snapshot / screenshot / get_text / evaluate / console / network
    interact.ts     click / type / press_key / hover / select / scroll / drag / upload / wait_for / dialog
    tabs.ts         tabs / resize / close
test/
  fixture-server.ts 테스트용 로컬 사이트
  smoke.test.ts     엔드투엔드 스모크 테스트
```

## 문제 해결

- **`Executable doesn't exist`**: `npx playwright install chromium` (또는 firefox/webkit)을 실행하세요. Playwright 버전을 올린 뒤에도 다시 필요합니다.
- **창이 뜨는 게 싫다면**: `--headless` 또는 `BROWSER_MCP_HEADLESS=1`.
- **봇 차단이 심한 사이트**: `--channel chrome`으로 실제 Chrome을 쓰고 `--user-data-dir`로 로그인 상태를 유지하면 도움이 됩니다.
- **사내 프록시 환경**: 브라우저는 셸의 `HTTP_PROXY` 환경 변수를 자동으로 따르지 않습니다. 외부 사이트가 열리지 않으면 `--proxy <url>`(또는 `BROWSER_MCP_PROXY`)을 지정하세요.
- **서버 로그**: 모든 로그는 stderr로만 출력됩니다(stdout은 MCP 프로토콜 채널). Claude Code에서는 `claude mcp list` / 서버 로그로 확인할 수 있습니다.
- **클라이언트가 종료됐는데 브라우저가 남아 있다면**: 서버는 stdin EOF 또는 SIGTERM을 받으면 브라우저를 닫습니다. 강제 종료(`kill -9`)된 경우에만 남을 수 있습니다.
