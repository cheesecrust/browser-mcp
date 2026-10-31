# browser-mcp

AI 에이전트(Claude Code, Claude Desktop, Cursor 등)가 **실제 브라우저를 직접 조작**할 수 있게 해주는
[MCP(Model Context Protocol)](https://modelcontextprotocol.io) 서버입니다. 내부적으로 [Playwright](https://playwright.dev)를 사용합니다.

- 페이지를 열고, 접근성 트리 **스냅샷**(각 요소에 `[ref=e12]` 같은 id가 붙음)을 읽은 뒤, ref로 클릭/입력/선택
- 모든 액션이 **변경된 페이지 스냅샷을 함께 반환**하므로 왕복 횟수가 적음
- 스크린샷, 텍스트 추출, JavaScript 실행, 탭 관리, 다이얼로그 처리, 콘솔/네트워크 로그 조회
- 헤드리스/헤디드, Chromium/Firefox/WebKit, 설치된 Chrome 사용, 로그인 유지용 영속 프로필 지원
- **원격(HTTP) 모드**: 서버 한 대를 여러 사람이 카카오 로그인(또는 고정 토큰)으로 나눠 쓰고, 사용자별로 브라우저·로그인 상태가 분리됨 ([아래 참고](#원격http-모드-서버-한-대를-여러-사람이-쓰기))

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

### 서버 실행: 카카오 로그인

사용자가 각자 카카오계정으로 로그인하고, 서버는 허용 목록에 있는 계정에게만 토큰을 발급합니다.
MCP 표준 OAuth 흐름이라 Claude Code 등은 서버 주소만 등록하면 브라우저 창에서 카카오 로그인이 열립니다.

1. [Kakao Developers](https://developers.kakao.com)에서 애플리케이션을 만들고 **앱 키 → REST API 키**를 확인합니다.
2. **제품 설정 → 카카오 로그인**을 켜고, Redirect URI에 `https://<호스트>/oauth/kakao/callback`을 등록합니다.
3. **카카오 로그인 → 보안**에서 Client Secret을 생성해 활성화합니다.
4. 이메일로 사용자를 허용하려면 **동의항목**에서 카카오계정(이메일)을 켜고 `BROWSER_MCP_KAKAO_SCOPE=account_email`을 설정합니다. 카카오 회원번호(id)로 허용하면 동의항목 설정이 필요 없습니다.

```bash
BROWSER_MCP_PUBLIC_URL=https://<호스트> \
BROWSER_MCP_KAKAO_CLIENT_ID=<REST API 키> \
BROWSER_MCP_KAKAO_CLIENT_SECRET=<Client Secret> \
BROWSER_MCP_ALLOWED_USERS="123456789,someone@example.com" \
node dist/index.js --http --host 0.0.0.0 --port 3000
```

- `BROWSER_MCP_ALLOWED_USERS`에는 카카오 회원번호와 이메일을 섞어 쓸 수 있고 `*`를 주면 모든 카카오계정을 허용합니다. 목록에 없는 계정이 로그인하면 거부되고, 서버 로그에 `login denied: Kakao id 123456789 (닉네임)`처럼 회원번호가 남으므로 그 값을 목록에 추가하면 됩니다.
- 발급된 토큰은 해시로만 `<data-dir>/auth/`에 저장되고, 액세스 토큰은 기본 24시간(`--access-token-ttl`), 리프레시 토큰은 30일 뒤 만료됩니다. 리프레시는 자동으로 일어나므로 사용자는 한 달에 한 번 정도만 다시 로그인합니다.
- `--public-url`은 클라이언트가 보는 주소이며 https여야 합니다(루프백 주소만 http 허용). 카카오 쪽에 등록하는 Redirect URI와 같은 호스트여야 합니다.
- 사용자 디렉터리는 `users/kakao-<회원번호>/`로 만들어지고 `profile.json`에 닉네임과 이메일이 기록됩니다.

### 서버 실행: 고정 토큰

카카오 로그인 대신, 또는 함께 쓸 수 있습니다. 토큰은 16자 이상의 무작위 문자열이면 되고, 환경 변수 또는 JSON 파일로 넘깁니다.

```bash
# 토큰 생성
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# 환경 변수로 (token:user 쌍을 쉼표로 구분)
BROWSER_MCP_TOKENS="<토큰1>:alice,<토큰2>:bob" node dist/index.js --http --host 0.0.0.0 --port 3000

# 또는 파일로 (tokens.example.json 참고)
node dist/index.js --http --host 0.0.0.0 --tokens-file tokens.json
```

HTTP 모드는 기본적으로 헤드리스이며(화면이 있는 서버라면 `--headed`로 창을 띄울 수 있음), 카카오 로그인도 토큰도 없이는 127.0.0.1에서만(`--allow-unauthenticated`) 뜹니다.
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

이미지는 Playwright 공식 이미지(Chromium과 의존성 포함, 비root 사용자) 위에 만들어지고,
사용자 데이터는 `/data` 볼륨에 남습니다. Chromium이 `/dev/shm`을 쓰므로 compose 파일이 `shm_size`를 1 GB로 잡습니다.

이미지에는 실제 Google Chrome도 들어 있습니다(`--build-arg INSTALL_CHROME=0`으로 제외 가능). `.env`에
`BROWSER_MCP_HEADLESS=0`을 주면 엔트리포인트가 Xvfb(가상 디스플레이) 위에서 서버를 띄워 브라우저가 창이 있는
상태로 돌고, `BROWSER_MCP_CHANNEL=chrome`을 함께 주면 그 창이 Chromium 대신 Chrome이 됩니다. 쿠팡처럼 헤드리스
브라우저를 403으로 거부하는 사이트에 필요합니다(아래 문제 해결 참고). 가상 디스플레이 해상도는
`BROWSER_MCP_XVFB_SCREEN`(기본 `1280x720x24`)으로 바꿉니다.

### Lightsail / EC2에 SSH 없이 올리기

`deploy/lightsail-launch.sh`를 인스턴스 생성 화면의 **시작 스크립트**(Lightsail) 또는 **사용자 데이터**(EC2)에 붙여 넣으면,
첫 부팅 때 Docker 설치, 저장소 복제, `.env` 작성, HTTPS 포함 실행까지 혼자 끝냅니다. 노트북에서 SSH를 열 일이 없습니다.

1. 스크립트 위쪽의 설정값을 채웁니다: `DOMAIN`, `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET`, `ALLOWED_USERS` (고정 토큰만 쓰면 `STATIC_TOKENS`, 서버가 발급하게 하려면 `ISSUE_TOKENS="true"`와 `ADMIN_TOKEN`).
2. Ubuntu 24.04, 4 GB 이상 플랜으로 인스턴스를 만들면서 스크립트를 붙여 넣습니다. 2 GB 플랜이면 스크립트가 스왑을 추가합니다.
3. 고정 IP를 붙이고 도메인의 A 레코드를 그 IP로 설정합니다. 방화벽은 80, 443만 엽니다(SSH 규칙은 지우거나 Lightsail 브라우저 클라이언트로만 제한).
4. Kakao Developers의 Redirect URI에 `https://<도메인>/oauth/kakao/callback`을 등록합니다.
5. 몇 분 뒤 `https://<도메인>/healthz`가 `{"ok":true,...}`를 돌려주면 완료입니다.

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

### 클라이언트 등록

카카오 로그인을 쓰는 서버는 주소만 등록하면 됩니다. 첫 연결 때 클라이언트가 브라우저로 카카오 로그인 창을 열고, 이후에는 토큰을 알아서 갱신합니다.

```bash
# Claude Code (카카오 로그인)
claude mcp add --transport http --scope user browser https://<호스트>/mcp
```

```toml
# Codex (~/.codex/config.toml, 카카오 로그인)
[mcp_servers.browser]
url = "https://<호스트>/mcp"
```

고정 토큰을 쓰는 서버는 헤더로 토큰을 넘깁니다. `Authorization: Bearer <토큰>`이 기본이고, 헤더 형식을 정해 둔 게이트웨이를 위해 `Authorization: <토큰>`과 `X-API-Key: <토큰>`도 받습니다.

```bash
# Claude Code (고정 토큰)
claude mcp add --transport http --scope user browser https://<호스트>/mcp --header "Authorization: Bearer <토큰>"
```

```toml
# Codex (~/.codex/config.toml, 고정 토큰)
[mcp_servers.browser]
url = "https://<호스트>/mcp"
bearer_token_env_var = "BROWSER_MCP_TOKEN"   # 토큰을 담은 환경 변수 이름
```

```json
// Cursor 등 JSON 설정 (고정 토큰)
{ "mcpServers": { "browser": { "url": "https://<호스트>/mcp", "headers": { "Authorization": "Bearer <토큰>" } } } }
```

ChatGPT 웹과 Claude.ai의 커스텀 커넥터는 OAuth 서버를 요구하므로 카카오 로그인을 켠 서버에 연결할 수 있습니다. 두 서비스 모두 공개 HTTPS 주소가 필요합니다.

### PlayMCP에 등록하기

[PlayMCP](https://playmcp.kakao.com)의 서버 개발 가이드는 Streamable HTTP 원격 서버, 서버당 툴 20개 이하(권장 3~10개), 모든 툴의 `annotations`(title과 네 가지 hint), 텍스트만 담은 응답, 세션 없는(stateless) 호출을 요구하거나 권장합니다. 그래서 채팅용 엔드포인트가 따로 있습니다.

| 엔드포인트 | 툴 | 용도 |
|---|---|---|
| `https://<호스트>/mcp` | 25개 전체 | Claude Code, Codex, Cursor 같은 코딩 에이전트 |
| `https://<호스트>/mcp/lite` | 17개 (스크린샷·스크립트 실행·파일 업로드·콘솔/네트워크 조회 제외) | PlayMCP 등 채팅 UI |

두 주소는 같은 카카오 로그인과 같은 브라우저를 씁니다. 세션 ID 없이 들어온 `tools/call`도 그 사용자의 브라우저로 처리되므로, 세션을 유지하지 않는 게이트웨이에서도 대화가 이어지는 동안 같은 탭을 계속 다룹니다. `/mcp/lite`는 토큰 없는 `initialize`, `tools/list`, `ping`에도 답하므로 콘솔의 **정보 불러오기**가 로그인 전에 통과하고, 도구 실행(`tools/call`)만 카카오 로그인이 필요합니다. `Accept`에 `text/event-stream`이 없는 단순한 클라이언트에는 이벤트 스트림 대신 JSON으로 응답합니다.

등록 순서:

1. [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)로 `https://<호스트>/mcp/lite`에 연결해 카카오 로그인과 툴 목록을 미리 확인합니다(가이드가 요구하는 사전 점검).
2. PlayMCP는 OAuth 클라이언트 ID와 비밀값을 미리 받는 방식이므로 서버 `.env`에 클라이언트를 적어 두고 재시작합니다. 비밀값은 `openssl rand -hex 32`처럼 임의로 만듭니다. Redirect URI는 아직 모르니 비워 둡니다.
   ```
   BROWSER_MCP_OAUTH_CLIENTS=playmcp:<비밀값>
   ```
3. PlayMCP 개발자 콘솔에서 **새로운 MCP 서버 등록**: 식별자(영문·숫자만, `kakao` 포함 불가), 엔드포인트 URL `https://<호스트>/mcp/lite`를 넣고 **정보 불러오기**로 툴 17개가 보이는지 확인합니다. 인증 방식은 OAuth를 고르고 아래처럼 채운 뒤 **임시 등록**합니다.

   | 항목 | 값 |
   |---|---|
   | Client ID | `playmcp` (`.env`에 적은 id) |
   | Client Secret | `.env`에 적은 비밀값 |
   | Authorization Endpoint URL | `https://<호스트>/authorize` |
   | Token Endpoint URL | `https://<호스트>/token` |
   | Scope | `browser` |
   | Grant Type | Authorization Code |

4. 등록 후 PlayMCP가 메일로 보내주는 **Redirect URI**를 24시간 안에 `.env`에 추가하고 재시작합니다(`docker compose --profile https up -d`). 여러 개면 `|`로 잇고, 정확한 주소를 모르면 `https://playmcp.kakao.com/*`처럼 `*`로 끝나는 접두어도 됩니다. 이 클라이언트는 비밀값으로 자신을 증명하므로 PKCE 없이도 로그인할 수 있고, 토큰 요청은 `client_secret_post`와 `client_secret_basic` 둘 다 받습니다.
   ```
   BROWSER_MCP_OAUTH_CLIENTS=playmcp:<비밀값>:https://playmcp.kakao.com/<메일에 적힌 경로>
   ```
5. **도구함에 추가**해 AI 채팅에서 테스트한 뒤 **등록 및 심사 요청**을 보내고, 승인되면 공개 상태를 **전체 공개**로 바꿉니다.
6. 툴 이름이나 설명을 바꾸면 콘솔의 **정보 불러오기**를 다시 눌러 재심사를 받아야 PlayMCP 화면에 반영됩니다.

### 동작과 제한

- **브라우저와 세션**: 사용자마다 브라우저 하나가 뜨고, 그 사용자의 MCP 세션과 세션 없는 요청이 모두 같은 브라우저를 씁니다. 도구 호출이 없는 채로 `--idle-timeout`(기본 15분)이 지나면 브라우저가 닫히고(로그인 상태는 저장) 다음 호출 때 다시 뜹니다. 동시에 뜨는 브라우저는 `--max-sessions`(기본 20)개까지이고, 사용자당 MCP 세션은 `--max-sessions-per-user`(기본 10)개를 넘으면 가장 오래 쉰 세션부터 닫힙니다. 클라이언트는 `DELETE /mcp`로 세션을 바로 끝낼 수 있습니다.
- **사용자별 데이터**: `<data-dir>/users/<user>/`에 `storage-state.json`(로그인 상태), `downloads/`, `files/`(업로드용), `screenshots/`가 생깁니다. `browser_file_upload`의 경로와 `browser_screenshot`의 `savePath`는 이 안으로 제한되며 상대 경로로 씁니다.
- **네트워크 정책**: 기본으로 공개 웹 사이트만 열 수 있습니다. `file://`, `chrome://`, `localhost`, 사설 IP 대역, 링크로컬(클라우드 메타데이터 주소 포함), 사설 IP로 풀리는 도메인은 페이지 이동뿐 아니라 페이지 안의 하위 요청까지 차단됩니다. 사내망 사이트를 다뤄야 하면 `--allow-private-network`를 주세요.
- **사람에게 넘기기**: 로그인, 2단계 인증, 보안 문자(CAPTCHA)처럼 AI가 대신 해서는 안 되는 단계는 `browser_request_human`으로 처리합니다. 도구가 `https://<호스트>/view/<임의 코드>` 링크를 돌려주면 사람이 그 링크를 열어 서버 브라우저의 화면을 실시간으로 보면서 마우스와 키보드로 직접 조작하고, **완료**를 누르면 AI가 같은 브라우저로 이어서 진행합니다. 링크는 토큰 없이 열리지만 해당 사용자의 브라우저에만 연결되고 기본 10분(최대 30분) 뒤나 완료 시점에 만료됩니다. 로그인 상태는 평소처럼 사용자 데이터에 저장되므로 다음 호출부터는 사람이 다시 개입할 필요가 없습니다. 화면은 Chromium의 screencast(다른 엔진은 스크린샷 폴링)를 Server-Sent Events로 보내고, 입력은 작은 JSON 요청으로 돌아옵니다. 미리 로그인해 두려면 로컬에서 로그인한 뒤 Playwright storage state 파일을 `<data-dir>/users/<user>/storage-state.json`으로 복사해도 됩니다.
- **저장된 로그인(금고)**: 세션이 자주 끊기는 사이트는 아이디와 비밀번호를 서버 금고에 넣어 둘 수 있습니다. `browser_request_credentials`가 돌려주는 `https://<호스트>/secrets/<임의 코드>` 링크(10분 유효)에서 사람이 사이트 주소·아이디·비밀번호를 저장하면, 서버가 AES-256-GCM으로 봉인해 `<data-dir>/users/<user>/credentials.json`에 둡니다. AI에게는 이름, 도메인, 가려진 아이디(`al***m`)만 보이고 값은 절대 돌려주지 않습니다. 입력은 `browser_fill_credential`이 서버 안에서 하며, 활성 탭이 저장 때 적은 도메인(`naver.com`이면 `nid.naver.com` 같은 하위 도메인 포함)의 HTTPS 페이지일 때만 동작하므로 다른 사이트로 새어 나갈 수 없습니다. 봉인 키는 처음 실행 때 `<data-dir>/vault.key`에 만들어지며(`--vault-key`로 직접 줄 수도 있음) 이 키를 잃으면 저장된 로그인도 못 읽습니다. 서버 자체가 뚫리면 키와 함께 노출되는 구조이므로 중요한 계정보다는 반복 로그인이 번거로운 서비스에 쓰고, 2단계 인증이나 보안 문자는 여전히 사람에게 넘기기로 처리합니다.
- **로그**: 도구 호출마다 `user=… session=… tool=… ok=… ms=… url=…` 한 줄이 stderr에 남습니다.
- **프로토콜**: Streamable HTTP입니다. `initialize`로 세션(`Mcp-Session-Id`)을 여는 클라이언트(Claude Code, Codex, Cursor, OpenAI Responses API)와, 세션 없이 요청마다 `tools/call`만 보내는 게이트웨이(PlayMCP 등) 모두 지원합니다.

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
| `--timeout <ms>` | `BROWSER_MCP_TIMEOUT` | `15000` | 요소 액션 타임아웃 |
| `--navigation-timeout <ms>` | `BROWSER_MCP_NAVIGATION_TIMEOUT` | `30000` | 페이지 이동 타임아웃 |
| `--user-agent <ua>` | `BROWSER_MCP_USER_AGENT` | | User-Agent 지정 |
| `--locale <locale>` | `BROWSER_MCP_LOCALE` | | 브라우저 로케일 (`ko-KR` 등) |
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
| `--oauth-clients <spec>` | `BROWSER_MCP_OAUTH_CLIENTS` | | 미리 등록하는 OAuth 클라이언트 `id:secret[:redirect_uri\|...]`, 여러 개는 `;`로 구분 (PlayMCP용) |
| `--allow-private-network` | `BROWSER_MCP_ALLOW_PRIVATE_NETWORK` | stdio: on / http: off | 로컬 파일과 사설망 접근 허용 |
| `--vault-key <hex>` | `BROWSER_MCP_VAULT_KEY` | `<data-dir>/vault.key` 자동 생성 | 저장된 로그인을 봉인하는 32바이트 16진수 키 |
| `--public-url <url>` | `BROWSER_MCP_PUBLIC_URL` | | 클라이언트가 보는 서버 주소 (카카오 로그인에 필수) |
| `--kakao-client-id <key>` | `BROWSER_MCP_KAKAO_CLIENT_ID` | | 카카오 앱의 REST API 키. 지정하면 카카오 로그인 활성화 |
| `--kakao-client-secret <s>` | `BROWSER_MCP_KAKAO_CLIENT_SECRET` | | 카카오 앱의 Client Secret (환경 변수 권장) |
| `--kakao-scope <scopes>` | `BROWSER_MCP_KAKAO_SCOPE` | | 요청할 동의항목 (`account_email` 등) |
| `--allowed-users <list>` | `BROWSER_MCP_ALLOWED_USERS` | (없음) | 허용할 카카오 회원번호·이메일, `*`는 전체 허용 |
| `--access-token-ttl <sec>` | `BROWSER_MCP_ACCESS_TOKEN_TTL` | `86400` | 발급 토큰 유효 시간 |

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
  http.ts           HTTP 모드: 인증, 세션별 브라우저, 유휴 정리, /healthz, OAuth 엔드포인트
  handoff.ts        사람에게 넘기기: /view/<code> 뷰어 페이지, 화면 스트리밍, 입력 전달
  vault.ts          저장된 로그인 금고: AES-GCM 봉인, /secrets/<code> 저장 페이지, 도메인 검사
  oauth.ts          카카오 로그인을 신원 확인으로 쓰는 OAuth 2.1 인증 서버 (등록, 인가, 토큰, 폐기)
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
  oauth.test.ts     카카오 로그인 테스트 (가짜 카카오 서버로 SDK 클라이언트의 OAuth 흐름 검증)
Dockerfile, docker-compose.yml, Caddyfile, .env.example   원격 배포용
deploy/
  lightsail-launch.sh  Lightsail/EC2 시작 스크립트 (SSH 없이 설치·실행)
  update.sh            브랜치가 바뀌었을 때 다시 빌드 (cron)
```

## 문제 해결

- **`Executable doesn't exist`**: `npx playwright install chromium` (또는 firefox/webkit)을 실행하세요. Playwright 버전을 올린 뒤에도 다시 필요합니다.
- **창이 뜨는 게 싫다면**: `--headless` 또는 `BROWSER_MCP_HEADLESS=1`.
- **쿠팡 등에서 홈만 열어도 `403 Access Denied`(Akamai)**: IP 문제가 아닙니다. 같은 IP에서 헤드리스 브라우저와 `navigator.webdriver=true`인 브라우저는 403, 창이 있는 실제 Chrome에 `--disable-blink-features=AutomationControlled`를 준 경우는 200이 나옵니다. 그래서 세 가지가 함께 필요합니다: 창이 있는 모드(서버에서는 Xvfb, Docker 이미지는 `BROWSER_MCP_HEADLESS=0`이면 자동), `--channel chrome`(이미지에 Chrome 포함), `--browser-arg=--disable-blink-features=AutomationControlled`. 로컬에서는 `node dist/index.js --channel chrome --browser-arg=--disable-blink-features=AutomationControlled`입니다. 다만 이런 사이트는 이용약관으로 자동화 접근을 금지하고 행동 패턴으로도 다시 막을 수 있으니, 사용자 본인 계정으로 사람 속도로 쓰는 범위를 지키세요.
- **사내 프록시 환경**: 브라우저는 셸의 `HTTP_PROXY` 환경 변수를 자동으로 따르지 않습니다. 외부 사이트가 열리지 않으면 `--proxy <url>`(또는 `BROWSER_MCP_PROXY`)을 지정하세요.
- **서버 로그**: 모든 로그는 stderr로만 출력됩니다(stdout은 MCP 프로토콜 채널). Claude Code에서는 `claude mcp list` / 서버 로그로 확인할 수 있습니다.
- **클라이언트가 종료됐는데 브라우저가 남아 있다면**: 서버는 stdin EOF 또는 SIGTERM을 받으면 브라우저를 닫습니다. 강제 종료(`kill -9`)된 경우에만 남을 수 있습니다.
- **HTTP 모드에서 `401`**: `Authorization: Bearer <토큰>` 헤더가 없거나 토큰이 틀리거나 만료된 경우입니다. 카카오 로그인 서버라면 클라이언트가 다시 로그인 창을 열고, 고정 토큰이라면 서버의 `BROWSER_MCP_TOKENS`/`--tokens-file`과 같아야 합니다.
- **카카오 로그인 후 `access_denied ... is not allowed on this server`**: 허용 목록에 없는 계정입니다. 서버 로그의 `login denied: Kakao id ...`에 찍힌 회원번호를 `BROWSER_MCP_ALLOWED_USERS`에 추가하고 서버를 재시작하세요.
- **카카오 로그인 창에서 `KOE006`(Redirect URI 불일치)**: Kakao Developers에 등록한 Redirect URI가 `<public-url>/oauth/kakao/callback`과 정확히 같은지 확인하세요.
- **HTTP 모드에서 `Session not found`**: 유휴 시간이 지나 세션이 닫혔거나 서버가 재시작된 경우입니다. 클라이언트를 다시 연결하면 새 세션이 열리고 로그인 상태는 복원됩니다.
- **`Cannot open ...: ... private or reserved address`**: 네트워크 정책이 사설망 접근을 막은 것입니다. 사내망 사이트가 대상이면 `--allow-private-network`를 주세요.
- **Lightsail에서 `/var/log/browser-mcp-setup.log`가 없다면**: 시작 스크립트가 실행되지 않은 것입니다. `sudo tail /var/log/cloud-init-output.log`로 원인을 보고, 위의 "직접 받아 실행" 방법으로 설치하세요.
- **Docker에서 탭이 죽는다면**: `/dev/shm`이 작아서입니다. compose 파일의 `shm_size: 1gb`를 유지하거나 `docker run --shm-size=1g`를 쓰세요.
