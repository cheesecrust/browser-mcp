/**
 * End-to-end smoke test: spawns the built server over stdio exactly like an MCP
 * host would, drives a local fixture site through the tools, and asserts on the
 * results. Run with `npm test` (builds first) after `npx playwright install chromium`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startFixtureServer } from './fixture-server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface CallOutcome {
  text: string;
  content: ContentBlock[];
  isError: boolean;
}

const EXPECTED_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_snapshot',
  'browser_screenshot',
  'browser_get_text',
  'browser_evaluate',
  'browser_console_messages',
  'browser_network_requests',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_select_option',
  'browser_scroll',
  'browser_drag',
  'browser_file_upload',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_resize',
  'browser_close',
].sort();

function step(name: string): void {
  console.log(`• ${name}`);
}

function refOf(snapshot: string, pattern: RegExp): string {
  const match = pattern.exec(snapshot);
  assert.ok(match?.[1], `no element matching ${pattern} in snapshot:\n${snapshot}`);
  return match[1];
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'browser-mcp-test-'));
  const stderrChunks: string[] = [];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(projectRoot, 'dist', 'index.js'),
      '--headless',
      '--browser',
      'chromium',
      '--browser-arg=--user-agent=browser-mcp-smoke-test/1.0',
    ],
    cwd: projectRoot,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  const client = new Client({ name: 'browser-mcp-smoke-test', version: '0.0.0' });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as ContentBlock[];
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    return { text, content, isError: result.isError === true };
  };
  const ok = async (name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
    const outcome = await call(name, args);
    assert.ok(!outcome.isError, `${name} failed: ${outcome.text}`);
    return outcome;
  };

  try {
    await client.connect(transport);

    step('tools/list exposes every browser tool');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools) assert.ok(tool.description, `${tool.name} has no description`);

    step('navigate returns a snapshot with refs');
    let home = await ok('browser_navigate', { url: fixture.baseUrl });
    assert.match(home.text, /Page: Fixture Home/);
    assert.match(home.text, /HTTP 200/);
    assert.match(home.text, /\[ref=(?:f\d+)*e\d+\]/);

    step('click a link by ref, then go back');
    const linkRef = refOf(home.text, /link "Go to page two"[^\n]*\[ref=(\w+)\]/);
    const page2 = await ok('browser_click', { ref: linkRef });
    assert.match(page2.text, /Page: Page Two/);
    assert.match(page2.text, /URL: .*\/page2/);
    home = await ok('browser_navigate_back');
    assert.match(home.text, /Page: Fixture Home/);
    const forward = await ok('browser_navigate_forward');
    assert.match(forward.text, /Page: Page Two/);
    home = await ok('browser_navigate_back');

    step('fill a form: type, select option, submit');
    const inputRef = refOf(home.text, /textbox "Search"[^\n]*\[ref=(\w+)\]/);
    const typed = await ok('browser_type', { ref: inputRef, text: 'hello world' });
    const selectRef = refOf(typed.text, /combobox "Color"[^\n]*\[ref=(\w+)\]/);
    const selected = await ok('browser_select_option', { ref: selectRef, values: ['Green'] });
    assert.match(selected.text, /option "Green" \[selected\]/);
    const submitRef = refOf(selected.text, /button "Search"[^\n]*\[ref=(\w+)\]/);
    const results = await ok('browser_click', { ref: submitRef });
    assert.match(results.text, /Page: Search results/);
    assert.match(results.text, /You searched for: hello world \(green\)/);

    step('type with submit=true presses Enter');
    home = await ok('browser_navigate', { url: fixture.baseUrl });
    const submitted = await ok('browser_type', { selector: '#q', text: 'enter key', submit: true });
    assert.match(submitted.text, /You searched for: enter key \(red\)/);

    step('alert dialog is reported and can be accepted');
    home = await ok('browser_navigate', { url: fixture.baseUrl });
    const alertRef = refOf(home.text, /button "Show alert"[^\n]*\[ref=(\w+)\]/);
    const alerted = await ok('browser_click', { ref: alertRef });
    assert.match(alerted.text, /dialog/i);
    assert.match(alerted.text, /Hello from alert/);
    const blocked = await call('browser_snapshot');
    assert.match(blocked.text, /Dialog: .*Hello from alert/);
    const blockedClick = await call('browser_click', { ref: alertRef });
    assert.ok(blockedClick.isError, 'actions must be refused while a dialog is open');
    const accepted = await ok('browser_handle_dialog', { accept: true });
    assert.match(accepted.text, /Accepted the alert dialog/);
    assert.match(accepted.text, /\[ref=(?:f\d+)*e\d+\]/, 'snapshot resumes after the dialog is handled');

    step('confirm dialog can be dismissed');
    await ok('browser_click', { selector: '#confirm-btn' });
    await ok('browser_handle_dialog', { accept: false });
    const confirmResult = await ok('browser_get_text', { selector: '#confirm-result' });
    assert.match(confirmResult.text, /cancelled/);

    step('popup opens a new tab; tabs can be listed, selected and closed');
    const popup = await ok('browser_click', { selector: '#popup-btn' });
    assert.match(popup.text, /New tab opened at index 1/);
    const list = await ok('browser_tabs', { action: 'list' });
    assert.match(list.text, /2 open tabs/);
    assert.match(list.text, /\[0\] \(active\) Fixture Home/);
    const switched = await ok('browser_tabs', { action: 'select', index: 1 });
    assert.match(switched.text, /Page: Page Two/);
    const closed = await ok('browser_tabs', { action: 'close', index: 1 });
    assert.match(closed.text, /1 open tab\b/);
    const afterClose = await ok('browser_snapshot');
    assert.match(afterClose.text, /Page: Fixture Home/);

    step('wait_for text that appears later');
    await ok('browser_click', { selector: '#delayed-btn' });
    const waited = await ok('browser_wait_for', { text: 'Delayed content appeared' });
    assert.match(waited.text, /Done waiting: text "Delayed content appeared" is visible/);
    const badWait = await call('browser_wait_for', {});
    assert.ok(badWait.isError);

    step('hover triggers mouseenter');
    await ok('browser_hover', { selector: '#hover-target' });
    const hovered = await ok('browser_get_text', { selector: '#hover-target' });
    assert.match(hovered.text, /hovered/);

    step('scroll reports the new position');
    const scrolled = await ok('browser_scroll', { direction: 'down', amount: 500 });
    assert.match(scrolled.text, /Scrolled down by 500px/);
    assert.match(scrolled.text, /y=[1-9]\d*\//);
    const intoView = await ok('browser_scroll', { selector: '#bottom' });
    assert.match(intoView.text, /into view/);

    step('evaluate expressions and functions, with and without an element');
    step('--browser-arg reaches the browser process');
    const ua = await ok('browser_evaluate', { expression: 'navigator.userAgent' });
    assert.match(ua.text, /browser-mcp-smoke-test\/1\.0/);

    const title = await ok('browser_evaluate', { expression: 'document.title' });
    assert.match(title.text, /"Fixture Home"/);
    const sum = await ok('browser_evaluate', { expression: '() => 1 + 2' });
    assert.match(sum.text, /\n3$/);
    const asyncValue = await ok('browser_evaluate', { expression: 'async () => { await new Promise(r => setTimeout(r, 20)); return { ok: true }; }' });
    assert.match(asyncValue.text, /"ok": true/);
    const elementId = await ok('browser_evaluate', { expression: '(el) => el.id', selector: '#intro' });
    assert.match(elementId.text, /"intro"/);
    const failing = await call('browser_evaluate', { expression: 'throw new Error("boom")' });
    assert.ok(failing.isError);
    assert.match(failing.text, /boom/);

    step('screenshot returns an image and can be saved');
    const shotPath = path.join(tempDir, 'shot.png');
    const shot = await ok('browser_screenshot', { savePath: shotPath });
    const image = shot.content.find((block) => block.type === 'image');
    assert.ok(image?.data && image.mimeType === 'image/png', 'screenshot must contain a png image block');
    assert.ok((await stat(shotPath)).size > 0, 'screenshot file was written');
    const elementShot = await ok('browser_screenshot', { selector: 'h1', type: 'jpeg', quality: 60 });
    assert.equal(elementShot.content.find((block) => block.type === 'image')?.mimeType, 'image/jpeg');

    step('file upload sets the input files');
    const uploadPath = path.join(tempDir, 'upload.txt');
    await writeFile(uploadPath, 'hello upload');
    await ok('browser_file_upload', { selector: '#file', paths: [uploadPath] });
    const fileName = await ok('browser_evaluate', { expression: '(el) => el.files[0].name', selector: '#file' });
    assert.match(fileName.text, /"upload.txt"/);
    const missing = await call('browser_file_upload', { selector: '#file', paths: [path.join(tempDir, 'nope.txt')] });
    assert.ok(missing.isError);

    step('press_key edits a field');
    await ok('browser_type', { selector: '#q', text: 'abc' });
    await ok('browser_press_key', { key: 'Backspace', selector: '#q' });
    const value = await ok('browser_evaluate', { expression: '(el) => el.value', selector: '#q' });
    assert.match(value.text, /"ab"/);

    step('console and network logs are recorded');
    const consoleAll = await ok('browser_console_messages');
    assert.match(consoleAll.text, /LOG: fixture loaded/);
    assert.match(consoleAll.text, /ERROR: fixture error log/);
    const consoleErrors = await ok('browser_console_messages', { level: 'error', clear: true });
    assert.match(consoleErrors.text, /ERROR: fixture error log/);
    assert.doesNotMatch(consoleErrors.text, /LOG: fixture loaded/);
    const consoleCleared = await ok('browser_console_messages');
    assert.match(consoleCleared.text, /No console messages/);
    const network = await ok('browser_network_requests', { filter: '127.0.0.1' });
    assert.match(network.text, /GET http:\/\/127\.0\.0\.1:\d+\/ -> 200 \[document\]/);

    step('resize changes the viewport');
    await ok('browser_resize', { width: 800, height: 600 });
    const width = await ok('browser_evaluate', { expression: 'window.innerWidth' });
    assert.match(width.text, /\n800$/);

    step('scoped snapshot refs resolve');
    const formSnapshot = await ok('browser_snapshot', { selector: 'form' });
    assert.match(formSnapshot.text, /Accessibility snapshot of "form"/);
    const scopedInput = refOf(formSnapshot.text, /textbox "Search"[^\n]*\[ref=(\w+)\]/);
    await ok('browser_type', { ref: scopedInput, text: 'scoped' });
    const scopedValue = await ok('browser_evaluate', { expression: '(el) => el.value', selector: '#q' });
    assert.match(scopedValue.text, /"scoped"/);

    step('bad refs and selectors produce readable errors');
    const badRef = await call('browser_click', { ref: 'nope' });
    assert.ok(badRef.isError);
    assert.match(badRef.text, /not a valid element ref/);
    const noTarget = await call('browser_click', {});
    assert.ok(noTarget.isError);
    assert.match(noTarget.text, /Provide either "ref"/);

    step('close, then relaunch on demand');
    const closedBrowser = await ok('browser_close');
    assert.match(closedBrowser.text, /Browser closed/);
    const relaunched = await ok('browser_navigate', { url: `${fixture.baseUrl}/page2` });
    assert.match(relaunched.text, /Page: Page Two/);
    await ok('browser_close');

    console.log('\nAll smoke tests passed.');
  } catch (error) {
    console.error('\nSmoke test FAILED:', error);
    const stderr = stderrChunks.join('');
    if (stderr) console.error('\n--- server stderr ---\n' + stderr.slice(-4000));
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    await fixture.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
