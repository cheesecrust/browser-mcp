import http from 'node:http';
import type { AddressInfo } from 'node:net';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

const HOME_BODY = `
<h1>Welcome to the fixture</h1>
<p id="intro">This is a test page for browser-mcp.</p>
<a href="/page2">Go to page two</a>
<form action="/search" method="get">
  <label for="q">Search</label>
  <input id="q" name="q" type="text" />
  <label for="color">Color</label>
  <select id="color" name="color">
    <option value="red">Red</option>
    <option value="green">Green</option>
    <option value="blue">Blue</option>
  </select>
  <button type="submit">Search</button>
</form>
<button id="alert-btn" onclick="alert('Hello from alert')">Show alert</button>
<button id="confirm-btn" onclick="document.getElementById('confirm-result').textContent = confirm('Proceed?') ? 'confirmed' : 'cancelled'">Show confirm</button>
<span id="confirm-result"></span>
<button id="popup-btn" onclick="window.open('/page2', '_blank')">Open popup</button>
<button id="delayed-btn" onclick="setTimeout(() => { const el = document.createElement('p'); el.id = 'delayed'; el.textContent = 'Delayed content appeared'; document.body.appendChild(el); }, 500)">Load delayed</button>
<label for="file">Attachment</label>
<input id="file" type="file" />
<div id="hover-target" onmouseenter="this.textContent = 'hovered'">hover me</div>
<div style="height: 3000px"></div>
<p id="bottom">Bottom of page</p>
<script>console.log('fixture loaded'); console.error('fixture error log');</script>
`;

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const html = (title: string, body: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(title, body));
    };
    switch (url.pathname) {
      case '/':
        return html('Fixture Home', HOME_BODY);
      case '/page2':
        return html('Page Two', '<h1>Second page</h1><a href="/">Home</a>');
      case '/search': {
        const q = escapeHtml(url.searchParams.get('q') ?? '');
        const color = escapeHtml(url.searchParams.get('color') ?? '');
        return html('Search results', `<p id="result">You searched for: ${q} (${color})</p>`);
      }
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
