/**
 * The page a browser gets at GET /tokens: issue, list, copy and revoke server-issued
 * tokens. It is plain HTML that calls the JSON API of the same path, so it holds no
 * secrets itself; the admin secret (when the server has one) is typed into the page
 * and kept in sessionStorage of that browser tab only.
 */

const STYLE = `
  :root { color-scheme: light dark; --bg: #f3f4f6; --fg: #111827; --muted: #6b7280; --card: #ffffff; --accent: #2563eb; --border: #e5e7eb; --danger: #dc2626; --ok: #15803d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #f3f4f6; --muted: #9ca3af; --card: #1c1f26; --accent: #60a5fa; --border: #2b2f3a; --danger: #f87171; --ok: #4ade80; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 13px; }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 16px; }
  section[hidden] { display: none; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
  input { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); }
  button { font: inherit; padding: 9px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; width: 100%; margin-top: 14px; }
  button.small { padding: 4px 10px; font-size: 13px; }
  button.danger { color: var(--danger); }
  code, .token { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .token { word-break: break-all; }
  .box { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
  .box .row { display: flex; gap: 8px; align-items: flex-start; }
  .box .grow { flex: 1; min-width: 0; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
  li:first-child { border-top: 0; }
  li .grow { flex: 1; min-width: 0; }
  li .user { font-weight: 600; }
  li .when { color: var(--muted); font-size: 12px; }
  .msg { margin-top: 10px; font-size: 13px; min-height: 1.5em; }
  .msg.err { color: var(--danger); }
  .msg.ok { color: var(--ok); }
`;

export function tokensPage(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>토큰 발급</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>토큰 발급</h1>
  <p class="muted">여기서 발급한 토큰으로 이 서버의 MCP(<code id="mcp-url"></code>)에 접속합니다. 토큰마다 브라우저와 저장된 로그인이 따로 유지됩니다.</p>
  <section id="admin" hidden>
    <h2>관리자 비밀</h2>
    <p class="muted">이 서버는 <code>--admin-token</code>으로 보호되어 있습니다. 비밀을 입력하면 이 탭에서만 기억합니다.</p>
    <input id="secret" type="password" autocomplete="off" placeholder="BROWSER_MCP_ADMIN_TOKEN 값">
    <button class="primary" id="unlock">확인</button>
    <div class="msg" id="admin-msg"></div>
  </section>
  <section id="issue" hidden>
    <h2>새 토큰 발급</h2>
    <label for="user">이름 (선택)</label>
    <input id="user" placeholder="비우면 user-xxxxxxxx 로 자동 지정" autocomplete="off" autocapitalize="off">
    <button class="primary" id="create">발급</button>
    <div class="msg" id="issue-msg"></div>
    <div class="box" id="result" hidden>
      <div class="muted">발급된 토큰 (<span id="result-user"></span>)</div>
      <div class="row"><div class="grow token" id="result-token"></div><button class="small" id="copy-token">복사</button></div>
      <div class="muted" style="margin-top:10px">Claude Code 등록 명령</div>
      <div class="row"><div class="grow token" id="result-cmd"></div><button class="small" id="copy-cmd">복사</button></div>
    </div>
  </section>
  <section id="issued" hidden>
    <h2>발급된 토큰</h2>
    <ul id="list"><li class="muted">불러오는 중…</li></ul>
    <div class="msg" id="list-msg"></div>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const api = location.pathname.replace(/\\/+$/, '');
  const mcpUrl = location.origin + '/mcp';
  $('mcp-url').textContent = mcpUrl;
  let secret = '';
  try { secret = sessionStorage.getItem('browser-mcp-admin') || ''; } catch {}
  const headers = () => {
    const h = { accept: 'application/json', 'content-type': 'application/json' };
    if (secret) h.authorization = 'Bearer ' + secret;
    return h;
  };
  const call = async (method, path, body) => {
    const r = await fetch(api + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401) { const e = new Error('관리자 비밀이 필요하거나 틀렸습니다.'); e.unauthorized = true; throw e; }
    if (r.status === 204) return {};
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('오류 ' + r.status));
    return data;
  };
  const show = (id, text, kind) => { const el = $(id); el.textContent = text; el.className = 'msg' + (kind ? ' ' + kind : ''); };
  const copy = async (text, button) => {
    try { await navigator.clipboard.writeText(text); button.textContent = '복사됨'; setTimeout(() => (button.textContent = '복사'), 1500); }
    catch { prompt('복사해 주세요:', text); }
  };
  const command = (token) => 'claude mcp add --transport http --scope user browser ' + mcpUrl + ' --header "Authorization: Bearer ' + token + '"';
  const render = (tokens) => {
    const list = $('list'); list.innerHTML = '';
    if (!tokens.length) { list.innerHTML = '<li class="muted">아직 발급된 토큰이 없습니다.</li>'; return; }
    for (const t of tokens) {
      const li = document.createElement('li');
      const grow = document.createElement('div'); grow.className = 'grow';
      const user = document.createElement('div'); user.className = 'user'; user.textContent = t.user;
      const token = document.createElement('div'); token.className = 'token'; token.textContent = t.token || '(이 서버 버전에서는 토큰을 저장하지 않았습니다)';
      const when = document.createElement('div'); when.className = 'when'; when.textContent = new Date(t.createdAt).toLocaleString();
      grow.append(user, token, when);
      const cp = document.createElement('button'); cp.className = 'small'; cp.textContent = '복사'; cp.disabled = !t.token;
      cp.onclick = () => copy(t.token, cp);
      const del = document.createElement('button'); del.className = 'small danger'; del.textContent = '회수';
      del.onclick = async () => {
        if (!confirm('"' + t.user + '" 토큰을 회수할까요? 열린 브라우저와 세션이 닫힙니다.')) return;
        try { await call('DELETE', '/' + encodeURIComponent(t.user)); show('list-msg', '"' + t.user + '" 토큰을 회수했습니다.', 'ok'); await load(); }
        catch (err) { show('list-msg', err.message, 'err'); }
      };
      li.append(grow, cp, del); list.append(li);
    }
  };
  const unlocked = (yes) => { $('admin').hidden = yes; $('issue').hidden = !yes; $('issued').hidden = !yes; };
  const load = async () => {
    try { const data = await call('GET', ''); unlocked(true); render(data.tokens || []); }
    catch (err) {
      if (err.unauthorized) { unlocked(false); if (secret) show('admin-msg', '비밀이 틀렸습니다.', 'err'); return; }
      unlocked(true); show('list-msg', err.message, 'err');
    }
  };
  $('unlock').onclick = () => {
    secret = $('secret').value.trim();
    try { sessionStorage.setItem('browser-mcp-admin', secret); } catch {}
    show('admin-msg', '');
    load();
  };
  $('secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock').click(); });
  $('create').onclick = async () => {
    show('issue-msg', '발급 중…');
    try {
      const name = $('user').value.trim();
      const data = await call('POST', '', name ? { user: name } : {});
      $('user').value = '';
      $('result-user').textContent = data.user;
      $('result-token').textContent = data.token;
      $('result-cmd').textContent = command(data.token);
      $('result').hidden = false;
      show('issue-msg', '"' + data.user + '" 토큰을 발급했습니다. 아래 목록에서도 다시 볼 수 있습니다.', 'ok');
      await load();
    } catch (err) { show('issue-msg', err.message, 'err'); if (err.unauthorized) unlocked(false); }
  };
  $('copy-token').onclick = (e) => copy($('result-token').textContent, e.currentTarget);
  $('copy-cmd').onclick = (e) => copy($('result-cmd').textContent, e.currentTarget);
  load();
})();
</script>
</body>
</html>`;
}
