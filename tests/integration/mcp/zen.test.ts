/**
 * Integration tests for the zen module, called through the MCP server.
 * Requires FIREFOX_PATH to point at a Zen Browser binary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixtureUrl } from '../../helpers/firefox.js';
import { startMcpServer, type McpTestServer } from '../../helpers/mcp.js';

const isZen = /zen/i.test(process.env.FIREFOX_PATH ?? '');

describe.skipIf(!isZen)('zen tools (MCP)', () => {
  let server: McpTestServer | undefined;

  function mcp(): McpTestServer {
    if (!server) {
      throw new Error('MCP server did not start');
    }
    return server;
  }

  async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await mcp().callTool(name, args);
    expect(result.isError, result.text).toBe(false);
    return result.text;
  }

  async function tabIds(query: string): Promise<string[]> {
    const text = await ok('zen_list_tabs', { query });
    return text
      .split('\n')
      .slice(1)
      .map((line) => line.split(' | ')[0])
      .filter(Boolean);
  }

  beforeAll(async () => {
    server = await startMcpServer([
      '--tools',
      'pages',
      'zen',
      '--env',
      'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
    ]);
    for (const url of [
      fixtureUrl('simple.html'),
      fixtureUrl('form.html'),
      fixtureUrl('simple.html') + '#third',
    ]) {
      await ok('new_page', { url });
    }
  });

  afterAll(async () => {
    await server?.close();
  });

  it('creates a space once and reuses it by name', async () => {
    expect(await ok('zen_create_space', { name: 'Research' })).toMatch(/^Created Research/);
    expect(await ok('zen_create_space', { name: 'research' })).toMatch(/^Space already exists/);
    expect(await ok('zen_list_spaces')).toContain('Research');
  });

  it('lists unloaded and loaded tabs with filters and paging', async () => {
    const all = await ok('zen_list_tabs', { query: 'simple' });
    expect(all).toMatch(/^2 of \d+ tabs match/);

    const paged = await ok('zen_list_tabs', { query: 'simple', limit: 1 });
    expect(paged).toContain('... 1 more. Use offset=1');

    expect(await ok('zen_list_tabs', { query: 'simple', staleDays: 1 })).toMatch(/^0 of/);
  });

  it('rejects an unknown space in filters', async () => {
    const result = await mcp().callTool('zen_list_tabs', { space: 'Nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unknown space: Nope');
  });

  it('moves tabs to a space and reports unknown ids', async () => {
    const ids = await tabIds('simple');
    const text = await ok('zen_move_tabs', { tabIds: [...ids, 'no-such-tab'], space: 'Research' });
    expect(text).toContain('Moved 2 tab(s) to Research');
    expect(text).toContain('Unknown ids (1): no-such-tab');

    expect(await ok('zen_list_tabs', { space: 'Research' })).toMatch(/^2 of/);
    expect(await ok('zen_move_tabs', { tabIds: ids, space: 'Research' })).toContain(
      'Already there (2)'
    );
  });

  it('creates a folder, then adds to it', async () => {
    const [first, second] = await tabIds('simple');
    expect(
      await ok('zen_move_to_folder', { tabIds: [first], folder: 'Reading', space: 'Research' })
    ).toContain('Created folder Research/Reading: 1 tab(s)');
    expect(
      await ok('zen_move_to_folder', { tabIds: [second], folder: 'Reading', space: 'Research' })
    ).toContain('Added to folder Research/Reading: 1 tab(s)');
    expect(await ok('zen_list_spaces')).toContain('folders: Reading');
  });

  it('keeps pinned tabs unless asked and archives what it closes', async () => {
    const pinned = await tabIds('simple');
    const [form] = await tabIds('form.html');

    const dry = await ok('zen_close_tabs', { tabIds: [...pinned, form], dryRun: true });
    expect(dry).toContain('Dry run: would close 1 tab(s)');
    expect(dry).toContain('Kept pinned/Essential (2)');

    const closed = await ok('zen_close_tabs', { tabIds: [form] });
    const archivePath = closed.match(/Archive: (.+)$/m)?.[1];
    expect(closed).toContain('Closed 1 tab(s)');
    expect(archivePath).toBeTruthy();
    const archive = JSON.parse(readFileSync(archivePath!, 'utf8'));
    expect(archive.tabs[0].url).toContain('form.html');
    expect(await tabIds('form.html')).toEqual([]);
  });

  it('saves the full listing to a file', async () => {
    const text = await ok('zen_list_tabs', { saveTo: true });
    const path = text.match(/saved to: (.+)$/m)?.[1];
    const tabs = JSON.parse(readFileSync(path!, 'utf8'));
    expect(tabs.some((t: { space: string }) => t.space === 'Research')).toBe(true);
  });
});

describe.skipIf(!isZen)('zen tools on a fresh connection (MCP)', () => {
  let server: McpTestServer | undefined;

  beforeAll(async () => {
    server = await startMcpServer(['--tools', 'zen', '--env', 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1']);
  });

  afterAll(async () => {
    await server?.close();
  });

  it('lists tabs when it is the first call to connect', async () => {
    const result = await server!.callTool('zen_list_tabs');
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^\d+ of \d+ tabs match/);
  });
});
