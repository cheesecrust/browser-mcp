# browser-mcp

AI 에이전트(Claude Code, Claude Desktop, Cursor 등)가 **실제 브라우저를 직접 조작**할 수 있게 해주는
[MCP(Model Context Protocol)](https://modelcontextprotocol.io) 서버입니다. 내부적으로 [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)(자동화 탐지를 피하도록 패치한 [Playwright](https://playwright.dev) 포크, API 동일)를 사용합니다.

- 페이지를 열고, 접근성 트리 **스냅샷**(각 요소에 `[ref=e12]` 같은 id가 붙음)을 읽은 뒤, ref로 클릭/입력/선택
- 모든 액션이 **변경된 페이지 스냅샷을 함께 반환**하므로 왕복 횟수가 적음
- 스크린샷, 텍스트 추출, JavaScript 실행, 탭 관리, 다이얼로그 처리, 네트워크 로그 조회 (콘솔 로그는 Firefox/WebKit에서만, [아래 참고](#patchright-제약))
- 헤드리스/헤디드, Chromium/Firefox/WebKit, 설치된 Chrome 사용, 로그인 유지용 영속 프로필 지원
- **원격(HTTP) 모드**: 서버 한 대를 여러 사람이 토큰으로 나눠 쓰고, 사용자별로 브라우저·로그인 상태가 분리됨 ([아래 참고](#원격http-모드-서버-한-대를-여러-사람이-쓰기))

## 요구 사항

- Node.js 20.11 이상
- 브라우저 바이너리 (아래 설치 명령 참고)

## 설치

```bash
cd /path/to/browser-mcp
npm install
npx patchright install chromium   # 처음 한 번 (Firefox/WebKit을 쓰려면 해당 브라우저도 설치. patchright의 탐지 우회 패치는 Chromium 계열에만 적용됨)
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
| `browser_console_messages` | 콘솔 출력과 처리되지 않은 에러 조회 (Chromium에서는 비어 있음, [patchright 제약](#patchright-제약)) |
| `browser_network_requests` | 네트워크 요청 목록 조회 |
| `browser_clear_cookies` | 한 사이트(하위 도메인 포함) 또는 전체 쿠키 삭제. 사이트가 모든 페이지에서 Access Denied를 낼 때(봇 방어 쿠키가 낡은 경우) 사용 |
| `browser_close` | 브라우저 종료 (다음 호출 시 자동 재실행) |
| `browser_request_human` | (원격 모드) 사람이 직접 조작할 수 있는 링크 발급: 로그인, 보안 문자 등 |
| `browser_request_credentials` | (원격 모드) 저장된 로그인 목록과, 사람이 로그인 정보를 추가·삭제하는 링크 |
| `browser_fill_credential` | (원격 모드) 저장된 아이디/비밀번호를 AI가 보지 않고 로그인 페이지에 입력 |

### 동작 방식 메모

- **ref**: 스냅샷의 `[ref=e12]`가 요소 id입니다(페이지 이동 후에는 `f3e12`처럼 프레임 접두사가 붙기도 하며, 보이는 그대로 쓰면 됩니다). 가장 최근 스냅샷의 ref만 유효하며, 모든 액션 결과에 새 스냅샷이 포함되므로 그 ref를 사용하면 됩니다.
- **selector**: ref가 없을 때 Playwright 셀렉터(CSS, `text=`, `role=`, `xpath=`)를 쓸 수 있습니다. 여러 요소에 매칭되면 Playwright의 strict 모드 에러가 후보 목록과 함께 반환됩니다.
- **다이얼로그**: `alert`/`confirm`/`prompt`가 뜨면 액션 결과에 표시되고, 처리 전까지 다른 액션은 거부됩니다. `browser_handle_dialog`로 처리하세요.
- **새 탭**: 팝업이 열리면 결과에 `New tab opened at index N`이 표시됩니다. `browser_tabs`의 `select`로 전환합니다.
- **긴 스냅샷**: 기본 30,000자에서 잘립니다(`--snapshot-max-chars`). 필요하면 `browser_snapshot`에 `selector`를 주거나 `browser_get_text`를 사용하세요.
- 도구 호출은 서버 안에서 **직렬화**되어 실행됩니다(동시에 두 액션이 한 페이지를 건드리지 않음).
- 다운로드는 자동으로 저장되며(`--downloads-dir`, 기본은 OS 임시 디렉터리) 서버 stderr 로그에 경로가 찍힙니다.

## 원격(HTTP) 모드: 서버 한 대를 여러 사람이 쓰기

`--http`를 주면 stdio 대신 Streamable HTTP(`/mcp`)로 서비스합니다. 접속한 클라이언트마다 MCP 세션이 하나 생기고,
세션마다 Chromium이 따로 떠서 탭과 쿠키가 섞이지 않습니다. 사용자는 Bearer 토큰으로 식별되고,
로그인 상태(쿠키·스토리지)는 사용자별로 저장돼 다음 세션에서 이어집니다.

### 서버 실행: 고정 토큰

토큰은 16자 이상의 무작위 문자열이면 되고, 환경 변수 또는 JSON 파일로 넘깁니다.

```bash
# 토큰 생성
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# 환경 변수로 (token:user 쌍을 쉼표로 구분)
BROWSER_MCP_TOKENS="<토큰1>:alice,<토큰2>:bob" node dist/index.js --http --host 0.0.0.0 --port 3000

# 또는 파일로 (tokens.example.json 참고)
node dist/index.js --http --host 0.0.0.0 --tokens-file tokens.json
```

HTTP 모드는 기본적으로 헤드리스이며(화면이 있는 서버라면 `--headed`로 창을 띄울 수 있음), 토큰 없이는 127.0.0.1에서만(`--allow-unauthenticated`) 뜹니다.
토큰을 미리 파일에 적어 두는 대신 서버가 발급하게 할 수도 있습니다. `--issue-tokens`를 켜면 브라우저로 `https://<호스트>/tokens`를 열어 토큰을 발급·회수할 수 있는 페이지가 나오고(토큰 값은 발급 직후 한 번만 표시), 같은 주소가 스크립트용 JSON API이기도 합니다. `POST /tokens`가 겹치지 않는 임의 토큰을 만들어 돌려주고, `GET /tokens`로 지금까지 발급한 토큰을 다시 볼 수 있습니다. 발급 내역은 `<data-dir>/issued-tokens.json`(0600)에 토큰 원문째 저장되므로 이 파일과 관리자 비밀은 샌드박스 밖으로 내보내지 마세요. 발급된 토큰만 통과하며, 토큰마다 별도 사용자(워크스페이스·세션)가 됩니다.

```bash
node dist/index.js --http --host 0.0.0.0 --issue-tokens --admin-token <16자 이상 비밀>

curl -X POST https://<호스트>/tokens -H "Authorization: Bearer <비밀>"                       # 이름 자동 (user-xxxx)
curl -X POST https://<호스트>/tokens -H "Authorization: Bearer <비밀>" -H "content-type: application/json" -d '{"user":"alice"}'
curl https://<호스트>/tokens -H "Authorization: Bearer <비밀>"                                 # 발급된 토큰 목록 {"tokens":[{"token","user","createdAt"}]}
curl -X DELETE https://<호스트>/tokens/alice -H "Authorization: Bearer <비밀>"                 # 회수: 브라우저와 세션도 닫힘
```

`--admin-token`을 생략하면 `/tokens`가 누구에게나 열립니다(샌드박스용).
토큰이 헤더로 오가므로 외부에 열 때는 반드시 HTTPS 리버스 프록시 뒤에 두세요. `GET /healthz`가 상태와 세션 수를 돌려줍니다.

Docker로 올리려면:

```bash
cp .env.example .env               # BROWSER_MCP_TOKENS 입력, HTTPS를 쓰면 DOMAIN도
docker compose up -d --build       # 127.0.0.1:3000 에 HTTP로 (앞에 자체 리버스 프록시를 두는 경우)
docker compose --profile https up -d --build   # Caddy가 $DOMAIN 의 인증서를 받아 HTTPS 로 서비스
```

이미지는 Playwright 공식 이미지(Chromium과 의존성 포함, 비root 사용자) 위에 만들어지고(patchright는 같은 Chromium 빌드를 쓰므로 이미지 태그의 Playwright 버전과 patchright 버전을 맞춰야 함),
사용자 데이터는 `/data` 볼륨에 남습니다. Chromium이 `/dev/shm`을 쓰므로 compose 파일이 `shm_size`를 1 GB로 잡습니다.

이미지에는 실제 Google Chrome도 들어 있습니다(`--build-arg INSTALL_CHROME=0`으로 제외 가능). `.env`에
`BROWSER_MCP_HEADLESS=0`을 주면 엔트리포인트가 Xvfb(가상 디스플레이) 위에서 서버를 띄워 브라우저가 창이 있는
상태로 돌고, `BROWSER_MCP_CHANNEL=chrome`을 함께 주면 그 창이 Chromium 대신 Chrome이 됩니다. 쿠팡처럼 헤드리스
브라우저를 403으로 거부하는 사이트에 필요합니다(아래 문제 해결 참고). 가상 디스플레이 해상도는
`BROWSER_MCP_XVFB_SCREEN`(기본 `1920x1080x24`)으로 바꿉니다. 엔트리포인트는 Xvfb를 감시해 죽으면 다시 띄우고(그 순간 열려 있던
브라우저는 함께 닫히며 다음 도구 호출 때 새로 뜸), 컨테이너 재시작으로 `/tmp`에 남은 이전 Xvfb의 lock 파일은 기동 전에 지웁니다. 이미지는 브라우저 시계를 `BROWSER_MCP_TIMEZONE`(기본 `Asia/Seoul`)에
맞추고 한글 폰트(Noto Sans CJK, 나눔)를 넣어 둡니다. 컨테이너의 UTC 시계와 폰트 없는 글꼴 목록은 사이트가 서버 브라우저를
알아보는 단서가 되기 때문입니다.

### Lightsail / EC2에 SSH 없이 올리기

`deploy/lightsail-launch.sh`를 인스턴스 생성 화면의 **시작 스크립트**(Lightsail) 또는 **사용자 데이터**(EC2)에 붙여 넣으면,
첫 부팅 때 Docker 설치, 저장소 복제, `.env` 작성, HTTPS 포함 실행까지 혼자 끝냅니다. 노트북에서 SSH를 열 일이 없습니다.

1. 스크립트 위쪽의 설정값을 채웁니다: `DOMAIN`과 `STATIC_TOKENS` (서버가 발급하게 하려면 대신 `ISSUE_TOKENS="true"`와 `ADMIN_TOKEN`).
2. Ubuntu 24.04, 4 GB 이상 플랜으로 인스턴스를 만들면서 스크립트를 붙여 넣습니다. 2 GB 플랜이면 스크립트가 스왑을 추가합니다.
3. 고정 IP를 붙이고 도메인의 A 레코드를 그 IP로 설정합니다. 방화벽은 80, 443만 엽니다(SSH 규칙은 지우거나 Lightsail 브라우저 클라이언트로만 제한).
4. 몇 분 뒤 `https://<도메인>/healthz`가 `{"ok":true,...}`를 돌려주면 완료입니다.

진행 상황은 `/var/log/browser-mcp-setup.log`에 남고, 콘솔의 브라우저 SSH에서 `docker compose -f /opt/browser-mcp/docker-compose.yml logs -f`로 서버 로그를 볼 수 있습니다.
Lightsail은 시작 스크립트를 자기 래퍼 안에서 `/bin/sh`로 실행하므로 이 스크립트는 bash 전용 문법 없이 POSIX sh로 유지합니다.

시작 스크립트를 붙여 넣지 못했거나 실행되지 않았다면(`/var/log/browser-mcp-setup.log`가 없음), 브라우저 SSH에서 직접 받아 실행해도 결과는 같습니다:

```bash
curl -fsSL https://raw.githubusercontent.com/cheesecrust/browser-mcp/main/deploy/lightsail-launch.sh -o setup.sh
nano setup.sh            # 위쪽 설정값 채우기
sudo sh setup.sh
```
`AUTO_UPDATE="true"`(기본)면 매시간 `deploy/update.sh`가 브랜치가 바뀌었을 때만 받아서 다시 빌드하므로, 코드 수정은 GitHub에 push하는 것으로 끝납니다.
바로 반영하려면 브라우저 SSH에서 `sudo /opt/browser-mcp/deploy/update.sh`를 실행합니다.

이미 떠 있는 인스턴스의 `.env`는 시작 스크립트가 다시 쓰지 않으므로, 설정을 바꿀 때는 `/opt/browser-mcp/.env`를 직접 고치고 재시작합니다:

```bash
sudo nano /opt/browser-mcp/.env                      # 예: BROWSER_MCP_ISSUE_TOKENS=1, BROWSER_MCP_ADMIN_TOKEN=... 추가
cd /opt/browser-mcp && sudo docker compose --profile https up -d
```

### Lightsail Windows에 올리기

주장하는 OS와 실제 OS가 같아야 하는 사이트를 위해, **Windows Server 2025**(또는 2022) 인스턴스에 Docker 없이 네이티브로 올리는 구성입니다. Windows UA가 진짜라서 UA, 화면 크기, WebGL 위장이 전부 필요 없고 자동화 플래그 제거만 남습니다.

> **쿠팡에는 이것으로도 부족합니다(2026-11-04 측정).** Lightsail Windows에서 홈 HTML은 열리지만 `/n-api/*`와 로그인의 인증번호 요청이 전부 403이고, 같은 인스턴스에서 **사람이 RDP로 Chrome을 직접 열어도 똑같이** 실패했습니다. 즉 자동화 탐지가 아니라 AWS 데이터센터 IP를 Akamai가 거부하는 것입니다(VM 환경도 의심했지만, 2026-11-08 사무실 망의 GPU 없는 Linux 컨테이너가 주문까지 통과해 배제됐습니다). 쿠팡이 목적이면 클라우드가 아니라 집이나 사무실 망의 기기(Mac, Linux, Docker 컨테이너 모두 가능)에서 서버를 돌리고 Cloudflare Tunnel이나 Tailscale로 접근하세요. 그 환경에서는 같은 자동화로 로그인과 주문까지 통과합니다([문제 해결](#문제-해결) 참고). 아래 절차는 Windows 브라우저가 필요한 다른 사이트에는 그대로 유효합니다.

1. Windows Server 2025(또는 2022), 4 GB 이상 플랜으로 인스턴스를 만들고 고정 IP를 붙인 뒤 도메인의 A 레코드를 그 IP로 설정합니다. Lightsail 방화벽은 80, 443과 RDP 3389(가능하면 내 IP로 제한)만 엽니다.
2. 인스턴스 페이지 **Connect**에서 기본 Administrator 비밀번호를 확인하고 RDP로 접속합니다.
3. `deploy/windows/lightsail-windows.ps1`을 인스턴스로 복사해 위쪽 설정값(`DOMAIN`, `STATIC_TOKENS` 또는 `ISSUE_TOKENS`·`ADMIN_TOKEN`, `AUTOLOGON_PASSWORD` 등)을 채우고, 관리자 PowerShell에서 실행합니다.
   ```powershell
   Set-ExecutionPolicy Bypass -Scope Process -Force; .\lightsail-windows.ps1
   ```
   Chocolatey로 Git, Node.js LTS, Chrome, Caddy를 설치하고 `C:\browser-mcp`에 저장소를 받아 빌드한 뒤 `.env`를 쓰고 예약 작업 세 개를 등록합니다: `browser-mcp server`(사용자 로그온 시, `deploy\windows\run-server.ps1`), `browser-mcp caddy`(부팅 시 SYSTEM, HTTPS), `browser-mcp update`(매시간, 브랜치가 바뀌면 재빌드). 진행 로그는 `C:\browser-mcp-setup.log`, 서버 로그는 `C:\browser-mcp\logs\server.log`입니다.
4. `https://<도메인>/healthz`가 응답하면 완료입니다.

Windows에서만 다른 점:

- 창이 있는 Chrome은 **로그인된 데스크톱 세션**이 있어야 뜹니다. 스크립트가 `AUTOLOGON_PASSWORD`로 자동 로그온을 켜고 서버를 그 세션의 로그온 시 작업으로 등록하므로 재부팅 뒤에도 사람 없이 올라옵니다. 비밀번호를 비워 두면 재부팅마다 RDP로 한 번 로그인해야 서버가 시작됩니다.
- RDP를 **그냥 닫으면 세션이 잠겨** Chrome이 화면을 그리지 않아 스크린샷과 사람에게 넘기기 화면이 비어 보입니다. 접속을 끊을 때는 세션 안에서 `deploy\windows\disconnect-rdp.cmd`를 관리자로 실행해 세션을 콘솔로 넘기세요.
- Node는 `.env`를 스스로 읽지 않으므로 `run-server.ps1`이 `.env`를 환경 변수로 올린 뒤 `node dist\index.js --http`를 실행합니다. 설정을 바꾸면 `C:\browser-mcp\.env`를 고치고 작업 스케줄러에서 `browser-mcp server`를 끝냈다가 다시 시작하거나 `deploy\windows\update.ps1`을 실행합니다.
- 한글 폰트(맑은 고딕)와 시간대(스크립트가 Korea Standard Time으로 설정)는 OS가 제공하므로 별도 설정이 없습니다.

### 클라이언트 등록

토큰은 헤더로 넘깁니다. `Authorization: Bearer <토큰>`이 기본이고, 헤더 형식을 정해 둔 게이트웨이를 위해 `Authorization: <토큰>`과 `X-API-Key: <토큰>`도 받습니다.

```bash
# Claude Code
claude mcp add --transport http --scope user browser https://<호스트>/mcp --header "Authorization: Bearer <토큰>"
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.browser]
url = "https://<호스트>/mcp"
bearer_token_env_var = "BROWSER_MCP_TOKEN"   # 토큰을 담은 환경 변수 이름
```

```json
// Cursor 등 JSON 설정
{ "mcpServers": { "browser": { "url": "https://<호스트>/mcp", "headers": { "Authorization": "Bearer <토큰>" } } } }
```

ChatGPT 웹과 Claude.ai의 커스텀 커넥터는 OAuth 서버를 요구하므로, 토큰만 받는 이 서버에는 연결할 수 없습니다.

### 채팅용 엔드포인트 `/mcp/lite`

채팅 UI 쪽 게이트웨이는 보통 툴 수 제한, 텍스트만 담은 응답, 세션 없는(stateless) 호출을 요구합니다. 그래서 채팅용 엔드포인트가 따로 있습니다.

| 엔드포인트 | 툴 | 용도 |
|---|---|---|
| `https://<호스트>/mcp` | 25개 전체 | Claude Code, Codex, Cursor 같은 코딩 에이전트 |
| `https://<호스트>/mcp/lite` | 17개 (스크린샷·스크립트 실행·파일 업로드·콘솔/네트워크 조회 제외) | 채팅 UI |

두 주소는 같은 토큰과 같은 브라우저를 씁니다. 세션 ID 없이 들어온 `tools/call`도 그 사용자의 브라우저로 처리되므로, 세션을 유지하지 않는 게이트웨이에서도 대화가 이어지는 동안 같은 탭을 계속 다룹니다. `/mcp/lite`는 토큰 없는 `initialize`, `tools/list`, `ping`에도 답하므로 게이트웨이의 사전 점검(툴 목록 불러오기)이 토큰 설정 전에 통과하고, 도구 실행(`tools/call`)만 토큰이 필요합니다. `Accept`에 `text/event-stream`이 없는 단순한 클라이언트에는 이벤트 스트림 대신 JSON으로 응답합니다.

### 동작과 제한

- **브라우저와 세션**: 사용자마다 브라우저 하나가 뜨고, 그 사용자의 MCP 세션과 세션 없는 요청이 모두 같은 브라우저를 씁니다. 도구 호출이 없는 채로 `--idle-timeout`(기본 15분)이 지나면 브라우저가 닫히고(로그인 상태는 저장) 다음 호출 때 다시 뜹니다. 동시에 뜨는 브라우저는 `--max-sessions`(기본 20)개까지이고, 사용자당 MCP 세션은 `--max-sessions-per-user`(기본 10)개를 넘으면 가장 오래 쉰 세션부터 닫힙니다. 클라이언트는 `DELETE /mcp`로 세션을 바로 끝낼 수 있습니다.
- **사용자별 데이터**: `<data-dir>/users/<user>/`에 `storage-state.json`(로그인 상태), `downloads/`, `files/`(업로드용), `screenshots/`가 생깁니다. `browser_file_upload`의 경로와 `browser_screenshot`의 `savePath`는 이 안으로 제한되며 상대 경로로 씁니다.
- **네트워크 정책**: 기본으로 공개 웹 사이트만 열 수 있습니다. `file://`, `chrome://`, `localhost`, 사설 IP 대역, 링크로컬(클라우드 메타데이터 주소 포함), 사설 IP로 풀리는 도메인은 페이지 이동뿐 아니라 페이지 안의 하위 요청까지 차단됩니다. 사내망 사이트를 다뤄야 하면 `--allow-private-network`를 주세요.
- **사람에게 넘기기**: 로그인, 2단계 인증, 보안 문자(CAPTCHA)처럼 AI가 대신 해서는 안 되는 단계는 `browser_request_human`으로 처리합니다. 도구가 `https://<호스트>/view/<임의 코드>` 링크를 돌려주면 사람이 그 링크를 열어 서버 브라우저의 화면을 실시간으로 보면서 마우스와 키보드로 직접 조작하고, **완료**를 누르면 AI가 같은 브라우저로 이어서 진행합니다. 링크는 토큰 없이 열리지만 해당 사용자의 브라우저에만 연결되고 기본 10분(최대 30분) 뒤나 완료 시점에 만료됩니다. 로그인 상태는 평소처럼 사용자 데이터에 저장되므로 다음 호출부터는 사람이 다시 개입할 필요가 없습니다. 화면은 Chromium의 screencast(다른 엔진은 스크린샷 폴링)를 Server-Sent Events로 보내고, 입력은 작은 JSON 요청으로 돌아옵니다. 미리 로그인해 두려면 로컬에서 로그인한 뒤 Playwright storage state 파일을 `<data-dir>/users/<user>/storage-state.json`으로 복사해도 됩니다.
- **저장된 로그인(금고)**: 세션이 자주 끊기는 사이트는 아이디와 비밀번호를 서버 금고에 넣어 둘 수 있습니다. `browser_request_credentials`가 돌려주는 `https://<호스트>/secrets/<임의 코드>` 링크(10분 유효)에서 사람이 사이트 주소·아이디·비밀번호를 저장하면, 서버가 AES-256-GCM으로 봉인해 `<data-dir>/users/<user>/credentials.json`에 둡니다. AI에게는 이름, 도메인, 가려진 아이디(`al***m`)만 보이고 값은 절대 돌려주지 않습니다. 입력은 `browser_fill_credential`이 서버 안에서 하며, 활성 탭이 저장 때 적은 도메인(`naver.com`이면 `nid.naver.com` 같은 하위 도메인 포함)의 HTTPS 페이지일 때만 동작하므로 다른 사이트로 새어 나갈 수 없습니다. 봉인 키는 처음 실행 때 `<data-dir>/vault.key`에 만들어지며(`--vault-key`로 직접 줄 수도 있음) 이 키를 잃으면 저장된 로그인도 못 읽습니다. 서버 자체가 뚫리면 키와 함께 노출되는 구조이므로 중요한 계정보다는 반복 로그인이 번거로운 서비스에 쓰고, 2단계 인증이나 보안 문자는 여전히 사람에게 넘기기로 처리합니다.
- **로그**: 도구 호출마다 `user=… session=… tool=… ok=… ms=… url=…` 한 줄이 stderr에 남습니다.
- **프로토콜**: Streamable HTTP입니다. `initialize`로 세션(`Mcp-Session-Id`)을 여는 클라이언트(Claude Code, Codex, Cursor, OpenAI Responses API)와, 세션 없이 요청마다 `tools/call`만 보내는 게이트웨이 모두 지원합니다.

## 실행 옵션

모든 옵션은 CLI 플래그 또는 `BROWSER_MCP_*` 환경 변수로 지정할 수 있습니다(플래그 우선).

| 플래그 | 환경 변수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `--headless` / `--headed` | `BROWSER_MCP_HEADLESS` | headed (HTTP 모드는 headless) | 창 표시 여부. HTTP 모드에서 창을 띄우려면 디스플레이(Xvfb 등)가 필요 |
| `--browser <name>` | `BROWSER_MCP_BROWSER` | `chromium` | `chromium` / `firefox` / `webkit` |
| `--channel <channel>` | `BROWSER_MCP_CHANNEL` | | 설치된 브라우저 사용: `chrome`, `msedge`, `chrome-beta` 등 |
| `--browser-arg <arg>` | `BROWSER_MCP_BROWSER_ARGS` | | 브라우저 프로세스에 넘길 추가 인자. 플래그는 반복, 환경 변수는 공백으로 구분 (`--browser-arg=--lang=ko-KR`) |
| `--executable-path <path>` | `BROWSER_MCP_EXECUTABLE_PATH` | | 특정 브라우저 실행 파일 |
| `--user-data-dir <dir>` | `BROWSER_MCP_USER_DATA_DIR` | | 영속 프로필 디렉터리 (로그인/쿠키 유지) |
| `--storage-state <file>` | `BROWSER_MCP_STORAGE_STATE` | | Playwright storage state JSON 로드 |
| `--viewport <WxH>` | `BROWSER_MCP_VIEWPORT` | `1280x720` | 뷰포트 크기 |
| `--screen <WxH>` | `BROWSER_MCP_SCREEN` | `1920x1080` | `window.screen`이 보고하는 화면 크기(뷰포트보다 작으면 뷰포트 크기). 지정하지 않으면 Playwright는 화면을 뷰포트와 같은 크기로 보고하는데, 실제 데스크톱에는 없는 조합이라 자동화 단서가 된다 |
| `--timeout <ms>` | `BROWSER_MCP_TIMEOUT` | `15000` | 요소 액션 타임아웃 |
| `--navigation-timeout <ms>` | `BROWSER_MCP_NAVIGATION_TIMEOUT` | `30000` | 페이지 이동 타임아웃 |
| `--user-agent <ua>` | `BROWSER_MCP_USER_AGENT` | | User-Agent 지정. Chromium에서는 `navigator.platform`과 클라이언트 힌트(Sec-CH-UA-Platform)도 그 UA의 OS에 맞춰 페이지와 cross-origin iframe에서 함께 바꿉니다. 웹 워커 안의 `navigator.platform`은 Chrome이 오버라이드를 무시해 호스트 OS가 그대로 보입니다 |
| `--locale <locale>` | `BROWSER_MCP_LOCALE` | | 브라우저 로케일 (`ko-KR` 등) |
| `--timezone <id>` | `BROWSER_MCP_TIMEZONE` | 호스트 시간대 (Docker 이미지는 `Asia/Seoul`) | 브라우저 시간대. 브라우저 프로세스의 `TZ`로 전달되어 페이지와 워커 모두에 적용 |
| `--ignore-https-errors` | `BROWSER_MCP_IGNORE_HTTPS_ERRORS` | off | 인증서 오류 무시 |
| `--snapshot-max-chars <n>` | `BROWSER_MCP_SNAPSHOT_MAX_CHARS` | `30000` | 스냅샷 최대 길이 |
| `--downloads-dir <dir>` | `BROWSER_MCP_DOWNLOADS_DIR` | OS temp | 다운로드 저장 위치 |
| `--proxy <url>` | `BROWSER_MCP_PROXY` | | 브라우저가 사용할 프록시 (`http://host:3128`, `socks5://host:1080`) |
| `--proxy-bypass <hosts>` | `BROWSER_MCP_PROXY_BYPASS` | | 프록시를 거치지 않을 호스트 (`localhost,*.internal`) |
| `--http` | `BROWSER_MCP_HTTP` | off | stdio 대신 Streamable HTTP(`/mcp`)로 서비스 |
| `--host <host>` | `BROWSER_MCP_HOST` | `127.0.0.1` | 수신 주소 (컨테이너 안에서는 `0.0.0.0`) |
| `--port <port>` | `BROWSER_MCP_PORT` | `3000` | 수신 포트 (`0`이면 빈 포트) |
| `--tokens-file <file>` | `BROWSER_MCP_TOKENS_FILE` | | 토큰→사용자 JSON 파일. 환경 변수 `BROWSER_MCP_TOKENS`(`token:user,...`)로도 지정 |
| `--allow-unauthenticated` | `BROWSER_MCP_ALLOW_UNAUTHENTICATED` | off | 토큰 없이 서비스 (127.0.0.1 전용) |
| `--issue-tokens` | `BROWSER_MCP_ISSUE_TOKENS` | off | `/tokens` 페이지와 API로 토큰 발급·조회·회수. `<data-dir>/issued-tokens.json`에 저장됨 |
| `--admin-token <secret>` | `BROWSER_MCP_ADMIN_TOKEN` | | `/tokens` 호출에 필요한 비밀(16자 이상). 없으면 엔드포인트가 열림 |
| `--data-dir <dir>` | `BROWSER_MCP_DATA_DIR` | `~/.browser-mcp` | 사용자별 상태 디렉터리 |
| `--idle-timeout <sec>` | `BROWSER_MCP_IDLE_TIMEOUT` | `900` | 유휴 세션 종료 시간 |
| `--max-sessions <n>` | `BROWSER_MCP_MAX_SESSIONS` | `20` | 동시에 뜨는 브라우저 수(사용자당 하나) |
| `--max-sessions-per-user <n>` | `BROWSER_MCP_MAX_SESSIONS_PER_USER` | `10` | 사용자당 MCP 세션 수. 넘으면 가장 오래 쉰 세션이 닫힘 |
| `--allow-private-network` | `BROWSER_MCP_ALLOW_PRIVATE_NETWORK` | stdio: on / http: off | 로컬 파일과 사설망 접근 허용 |
| `--vault-key <hex>` | `BROWSER_MCP_VAULT_KEY` | `<data-dir>/vault.key` 자동 생성 | 저장된 로그인을 봉인하는 32바이트 16진수 키 |
| `--public-url <url>` | `BROWSER_MCP_PUBLIC_URL` | | 사람에게 주는 링크(넘기기, 금고)에 쓰는 서버 주소. 없으면 요청이 들어온 주소를 씀 |

예: 로그인 상태를 유지하면서 설치된 Chrome으로 실행

```bash
node dist/index.js --channel chrome --user-data-dir ~/.browser-mcp-profile
```

## 개발

```bash
npm run dev          # tsx로 소스 직접 실행 (stdio)
npm run build        # dist/ 로 컴파일
npm run typecheck    # 소스 + 테스트 타입 검사
npm test             # 빌드 후 stdio 스모크 테스트와 HTTP 모드 테스트를 모두 실행
npm run test:stdio   # stdio 스모크 테스트만
npm run test:http    # HTTP 모드 테스트만
npm run start:http   # 빌드된 서버를 HTTP 모드로 실행 (토큰 환경 변수 필요)
npm run inspector    # MCP Inspector로 도구를 직접 호출해 보기
```

`npm test`는 로컬 HTTP 픽스처 서버를 띄우고, MCP 클라이언트로 서버 프로세스를 실제로 spawn 해서
탐색·클릭·폼 입력·다이얼로그·탭·스크린샷·업로드 등 모든 도구를 검증합니다. HTTP 모드 테스트는
토큰 인증, 사용자 간 격리, 세션 종료 후 로그인 상태 복원, 작업 디렉터리 제한, 네트워크 정책,
유휴 종료, SIGTERM 정리까지 확인합니다.

### 구조

```
src/
  index.ts          CLI 진입점, stdio 또는 HTTP 모드 선택, 종료 처리
  config.ts         플래그/환경 변수 파싱
  http.ts           HTTP 모드: 인증, 세션별 브라우저, 유휴 정리, /healthz, /tokens
  handoff.ts        사람에게 넘기기: /view/<code> 뷰어 페이지, 화면 스트리밍, 입력 전달
  vault.ts          저장된 로그인 금고: AES-GCM 봉인, /secrets/<code> 저장 페이지, 도메인 검사
  auth.ts           고정 토큰 파일/환경 변수 파싱과 Bearer 검증
  policy.ts         네트워크 정책: 차단 스킴, 사설 IP 판정, DNS 확인
  browser.ts        BrowserSession: 지연 실행, 탭, 다이얼로그, 콘솔/네트워크 로그, 상태 저장, 경로 제한
  snapshot.ts       접근성 스냅샷 + 페이지 설명 포맷
  server.ts         McpServer 생성과 도구 등록
  tools/
    common.ts       도구 등록 헬퍼, 직렬화 뮤텍스, 공통 결과 포맷
    navigation.ts   navigate / back / forward
    handoff.ts      request_human (사람에게 넘기기 링크)
    credentials.ts  request_credentials / fill_credential (금고)
    inspect.ts      snapshot / screenshot / get_text / evaluate / console / network
    interact.ts     click / type / press_key / hover / select / scroll / drag / upload / wait_for / dialog
    tabs.ts         tabs / resize / close
test/
  fixture-server.ts 테스트용 로컬 사이트
  smoke.test.ts     stdio 엔드투엔드 스모크 테스트
  http.test.ts      HTTP 모드 테스트 (인증, 격리, 영속성, 정책, 유휴 종료)
Dockerfile, docker-compose.yml, Caddyfile, .env.example   원격 배포용
deploy/
  lightsail-launch.sh  Lightsail/EC2 시작 스크립트 (SSH 없이 설치·실행)
  update.sh            브랜치가 바뀌었을 때 다시 빌드 (cron)
  windows/             Lightsail Windows용 설치 스크립트, 서버 실행 래퍼, 업데이트, Caddyfile
```

## patchright 제약

patchright는 사이트가 자동화를 탐지하는 데 쓰는 CDP 흔적(`Runtime.enable`, `Console.enable`, 유틸리티 스크립트 주입 등)을 없앤 Playwright 포크입니다. 그 대가로 다음이 달라집니다.

- **콘솔 로그를 못 받습니다**: Chromium에서 `page.on('console')`과 `page.on('pageerror')`가 오지 않으므로 `browser_console_messages`는 항상 비어 있고 그 이유를 함께 돌려줍니다. 페이지 값을 읽어야 하면 `browser_evaluate`를 쓰세요. Firefox/WebKit은 패치 대상이 아니라 원래대로 동작합니다.
- **탐지 우회 패치는 Chromium 계열에만** 적용됩니다. `--channel chrome`과 창이 있는 모드를 함께 쓰면 효과가 가장 큽니다.
- 브라우저 설치 명령이 `npx patchright install …`입니다. Playwright와 같은 Chromium 빌드를 받으므로 Docker 이미지의 Playwright 태그는 patchright 버전에 맞춥니다.

## 문제 해결

- **`Executable doesn't exist`**: `npx patchright install chromium` (또는 firefox/webkit)을 실행하세요. patchright 버전을 올린 뒤에도 다시 필요합니다.
- **창이 뜨는 게 싫다면**: `--headless` 또는 `BROWSER_MCP_HEADLESS=1`.
- **쿠팡 등에서 홈만 열어도 `403 Access Denied`(Akamai)**: 2026-11-07 Lightsail(Ubuntu, Docker, Mac UA) 측정으로 확인한 것은 **같은 IP에 걸리는 패널티**입니다. 403을 몇 번 받은 뒤에는 쿠키를 지워도, UA를 바꿔도 홈부터 403이었고, 4시간 뒤 첫 요청은 200, 그 직후 403을 한 번 더 받자 다시 403, 고정 IP를 새로 받아 붙이자 바로 홈 200이었습니다. AWS 대역 자체를 막는 것이 아니라 403이 쌓인 IP를 한동안 막는 것이므로, 403이 나오면 재시도하지 말고(한 번마다 길어짐) 몇 시간 쉬거나 Lightsail에서 고정 IP를 새로 받으세요. 낡은 봇 방어 쿠키(`_abck`, `bm_sz` 등)는 `browser_clear_cookies`로 먼저 지워 두는 것이 안전하지만, 이날 측정에서는 쿠키 삭제만으로 풀린 경우가 없었습니다. 그 밖의 원인은 아래 세 가지이고, 모두 JS가 돌기 전 엣지에서 거부하는 것입니다. (1) 헤드리스 브라우저나 `navigator.webdriver=true`인 브라우저. 창이 있는 실제 Chrome에 `--disable-blink-features=AutomationControlled`를 주면 통과합니다(서버에서는 Xvfb, Docker 이미지는 `BROWSER_MCP_HEADLESS=0`이면 자동, `--channel chrome`). 로컬에서는 `node dist/index.js --channel chrome --browser-arg=--disable-blink-features=AutomationControlled`입니다. (2) User-Agent와 클라이언트 힌트(`Sec-CH-UA-Platform`)가 서로 다른 OS를 말하는 경우. 같은 Mac에서 UA만 Linux로 바꾸고 힌트는 macOS로 두면 홈부터 403이고, 힌트까지 맞추면 200입니다. 서버는 `--user-agent`를 주면 힌트를 함께 맞추므로 `--browser-arg`로 UA를 따로 주지 마세요. (3) 같은 IP에서 403이 반복된 뒤의 IP 패널티(위 측정). 쿠키를 지워도 첫 요청부터 403이면 이 경우이고, 몇 시간 쉬거나 IP를 바꾸는 것 외에 방법이 없으며, 재시도할수록 길어집니다. 이런 사이트는 이용약관으로 자동화 접근을 금지하니 사용자 본인 계정으로 사람 속도로 쓰는 범위를 지키세요.
- **쿠팡에서 홈과 검색은 열리는데 로그인 페이지(`login.coupang.com`)가 403**: 브라우저가 주장하는 OS와 실제 환경이 다르거나, 데이터센터 IP·VM에서 도는 경우입니다. 통과 조건은 **주장하는 OS = 실제 OS, 그리고 집·사무실 회선의 실제 기기**이고, OS 자체는 Mac이든 Linux든 상관없습니다.

  측정 1 (2026-11-04, 같은 Mac·같은 IP에서 UA·`navigator.platform`·클라이언트 힌트만 바꿈):

  | 주장하는 OS | 홈 | `/n-api/*` | 로그인 페이지 |
  |---|---|---|---|
  | Mac (실제 OS) | 200 | 200 | 200 |
  | Linux (Mac이 흉내) | 200 | 200 | 403 (HTML부터, 센서 전송 전) |
  | Windows (Mac이 흉내) | 200 | 200 | 403 (홈 로드 중의 로그인 호스트 요청은 200, 센서 전송 뒤의 이동은 403) |

  측정 2 (2026-11-08): 사무실 회선(기업 ASN)의 **GPU 없는 Linux 환경**(WebGL 컨텍스트 생성 실패, 즉 WebGL 자체가 없음; `--no-sandbox`와 X11 가상 화면으로 띄운 자동화용 Chrome 156)에서 기본 Linux UA(`X11; Linux x86_64`)와 `--disable-blink-features=AutomationControlled`만으로 홈·로그인·주문까지 전부 통과. 따라서 측정 1의 Linux 행이 막힌 것은 Linux UA 때문이 아니라 Mac 하드웨어가 Linux를 흉내 내며 생긴 모순(WebGL 렌더러, 폰트, 워커 안의 `navigator.platform` 등 바꿀 수 없는 값) 때문이었고, WebGL이 없거나 소프트웨어 렌더링인 것 자체는 거부 사유가 아닙니다. 센서가 보는 것은 마우스 속도 같은 행동이 아니라 기기 정보의 **일관성**이라서, 실제 OS를 그대로 보고하면 컨테이너에서 자동화로 열어도 통과합니다.

  클라우드는 OS 모순을 없애도 막힙니다. [Lightsail Windows 인스턴스](#lightsail-windows에-올리기)는 사람이 직접 열어도 센서 단계에서 거부됐고, Lightsail Linux 컨테이너(2026-11-07, 새 고정 IP)는 Mac UA로 홈은 200이지만 로그인은 403이었습니다. 측정 2로 WebGL 유무와 가상 화면은 변수에서 빠졌으므로, 남는 차이는 **데이터센터(AWS) IP**입니다. 쿠팡은 집·사무실 망의 기기에서 돌린 서버로 쓰세요. 그 기기가 Mac이든 Linux든, Docker 컨테이너든 상관없고, UA는 바꾸지 말고 실제 OS 기본값으로 두세요. `BROWSER_MCP_USER_AGENT`(Mac UA)와 소프트웨어 WebGL 설정은 클라우드에서 www 조회용으로만 의미가 있습니다.
- **사내 프록시 환경**: 브라우저는 셸의 `HTTP_PROXY` 환경 변수를 자동으로 따르지 않습니다. 외부 사이트가 열리지 않으면 `--proxy <url>`(또는 `BROWSER_MCP_PROXY`)을 지정하세요.
- **서버 로그**: 모든 로그는 stderr로만 출력됩니다(stdout은 MCP 프로토콜 채널). Claude Code에서는 `claude mcp list` / 서버 로그로 확인할 수 있습니다.
- **클라이언트가 종료됐는데 브라우저가 남아 있다면**: 서버는 stdin EOF 또는 SIGTERM을 받으면 브라우저를 닫습니다. 강제 종료(`kill -9`)된 경우에만 남을 수 있습니다.
- **HTTP 모드에서 `401`**: `Authorization: Bearer <토큰>` 헤더가 없거나 토큰이 틀리거나 만료된 경우입니다. 서버의 `BROWSER_MCP_TOKENS`/`--tokens-file`, 또는 `/tokens`로 발급한 값과 같아야 합니다.
- **HTTP 모드에서 `Session not found`**: 유휴 시간이 지나 세션이 닫혔거나 서버가 재시작된 경우입니다. 클라이언트를 다시 연결하면 새 세션이 열리고 로그인 상태는 복원됩니다.
- **`Cannot open ...: ... private or reserved address`**: 네트워크 정책이 사설망 접근을 막은 것입니다. 사내망 사이트가 대상이면 `--allow-private-network`를 주세요.
- **Lightsail에서 `/var/log/browser-mcp-setup.log`가 없다면**: 시작 스크립트가 실행되지 않은 것입니다. `sudo tail /var/log/cloud-init-output.log`로 원인을 보고, 위의 "직접 받아 실행" 방법으로 설치하세요.
- **Docker에서 `headed browser without having a XServer running`으로 브라우저가 안 뜬다면**: 컨테이너 로그에 `(EE) Server is already active for display 99`가 있을 것입니다. `docker compose restart`는 컨테이너의 `/tmp`를 그대로 두므로 이전 Xvfb의 lock 파일이 남아 새 Xvfb가 바로 종료된 경우입니다. 현재 엔트리포인트는 기동 전에 그 파일을 지우고 Xvfb가 죽으면 다시 띄우므로, 예전 이미지라면 `docker compose up -d --build`로 다시 만들면 해결됩니다. 컨테이너 안에서 `pgrep -a Xvfb`가 `<defunct>`만 보여 주면 이 경우입니다.
- **Docker에서 탭이 죽는다면**: `/dev/shm`이 작아서입니다. compose 파일의 `shm_size: 1gb`를 유지하거나 `docker run --shm-size=1g`를 쓰세요.
