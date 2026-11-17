/**
 * Zen Browser tools: Spaces, folders and tab organization.
 * Runs in Zen's privileged browser window, so it requires the moz build and
 * MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.
 */

import { successResponse } from '../utils/response-helpers.js';
import { saveOutput } from '../utils/save-output.js';
import { defineModule, defineToolHandler, type ToolDefinition } from './module.js';
import type { McpToolResponse } from '../types/common.js';
import {
  handleSplitView,
  handleUnsplitView,
  handleView,
  splitViewTool,
  unsplitViewTool,
  viewTool,
} from './zen-view.js';

export interface ZenSpace {
  id: string;
  name: string;
  icon: string | null;
  folders: string[];
  tabCount: number;
}

export interface ZenTab {
  id: string;
  title: string;
  url: string;
  spaceId: string | null;
  folder: string | null;
  pinned: boolean;
  essential: boolean;
  selected: boolean;
  lastAccessed: number;
}

// A client that lets a model call these tools without asking the user each time can set
// ZEN_TOOLS_FIXED_OUTPUT=1: the tools then never write to a path the caller chose.
// Listing cannot save to a file, and closed tabs are archived only to the default folder.
const FIXED_OUTPUT = !!process.env.ZEN_TOOLS_FIXED_OUTPUT;

const SYSTEM_ACCESS_ERROR =
  'Privileged context access not enabled. Start Zen with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 and use the moz build of this server.';

// Shared by every chrome-side script. Runs inside browser.xhtml with chrome privileges.
const PRELUDE = `
  const w = Services.wm.getMostRecentWindow('navigator:browser');
  if (!w || !w.gZenWorkspaces) throw new Error('This browser is not Zen (gZenWorkspaces not found)');
  const ws = w.gZenWorkspaces, gb = w.gBrowser;
  const allTabs = () => [...ws.allStoredTabs].filter((t) => !t.hasAttribute('zen-empty-tab'));
  const spaces = () => ws.getWorkspaces();
  const findSpace = (key) => {
    const k = String(key).toLowerCase();
    return spaces().find((s) => s.uuid === key) ?? spaces().find((s) => s.name.toLowerCase() === k);
  };
  const folderOf = (t) => {
    let g = t.group;
    if (g?.hasAttribute('split-view-group')) g = g.group;
    return g?.tagName === 'zen-folder' ? g : null;
  };
  const tabUrl = (t) => {
    let url = t.linkedBrowser?.currentURI?.spec;
    if (!url || url === 'about:blank' || t.hasAttribute('pending')) {
      try {
        const s = JSON.parse(w.SessionStore.getTabState(t));
        url = s.entries?.[s.index - 1]?.url ?? url;
      } catch {}
    }
    return url ?? '';
  };
  const info = (t) => ({
    id: t.id,
    title: t.label ?? '',
    url: tabUrl(t),
    spaceId: t.getAttribute('zen-workspace-id'),
    folder: folderOf(t)?.label ?? null,
    pinned: !!t.pinned,
    essential: t.hasAttribute('zen-essential'),
    selected: !!t.selected,
    lastAccessed: t.lastAccessed ?? 0,
  });
  const byIds = (ids) => {
    const map = new Map(allTabs().map((t) => [t.id, t]));
    return { found: ids.map((id) => map.get(id)).filter(Boolean), missing: ids.filter((id) => !map.has(id)) };
  };
  const settle = (ms = 300) => new Promise((r) => w.setTimeout(r, ms));
`;

export const chromeFn = (body: string) => `async (argJson) => {
  const a = JSON.parse(argJson);
  ${PRELUDE}
  ${body}
}`;

const SCRIPTS = {
  listSpaces: chromeFn(`
    const tabs = allTabs();
    return JSON.stringify(spaces().map((s) => ({
      id: s.uuid,
      name: s.name,
      icon: s.icon && !s.icon.includes('://') ? s.icon : null,
      folders: [...new Set(tabs.filter((t) => t.getAttribute('zen-workspace-id') === s.uuid).map((t) => folderOf(t)?.label).filter(Boolean))],
      tabCount: tabs.filter((t) => t.getAttribute('zen-workspace-id') === s.uuid).length,
    })));
  `),
  listTabs: chromeFn(`return JSON.stringify(allTabs().map(info));`),
  createSpace: chromeFn(`
    const existing = findSpace(a.name);
    if (existing && !a.allowDuplicate) return JSON.stringify({ id: existing.uuid, name: existing.name, created: false });
    const s = await ws.createAndSaveWorkspace(a.name, a.icon || undefined, true);
    return JSON.stringify({ id: s.uuid, name: s.name, created: true });
  `),
  moveTabs: chromeFn(`
    const space = findSpace(a.space);
    if (!space) throw new Error('Unknown space: ' + a.space);
    const { found, missing } = byIds(a.tabIds);
    const skipped = found.filter((t) => t.hasAttribute('zen-essential')).map((t) => t.id);
    const movable = found.filter((t) => !t.hasAttribute('zen-essential'));
    const already = movable.filter((t) => t.getAttribute('zen-workspace-id') === space.uuid).map((t) => t.id);
    ws.moveTabsToWorkspace(movable, space.uuid);
    await settle();
    const moved = movable.filter((t) => t.getAttribute('zen-workspace-id') === space.uuid && !already.includes(t.id)).map((t) => t.id);
    const failed = movable.filter((t) => t.getAttribute('zen-workspace-id') !== space.uuid).map((t) => t.id);
    return JSON.stringify({ space: space.name, moved, already, skippedEssential: skipped, failed, missing });
  `),
  tabsByIds: chromeFn(`
    const { found, missing } = byIds(a.tabIds);
    return JSON.stringify({ tabs: found.map(info), missing });
  `),
  closeTabs: chromeFn(`
    const { found } = byIds(a.tabIds);
    for (const t of found) gb.removeTab(t, { animate: false, closeWindowWithLastTab: false });
    await settle();
    const remaining = new Set(allTabs().map((t) => t.id));
    return JSON.stringify({ closed: found.filter((t) => !remaining.has(t.id)).map((t) => t.id), stillOpen: found.filter((t) => remaining.has(t.id)).map((t) => t.id) });
  `),
  moveToFolder: chromeFn(`
    const space = a.space ? findSpace(a.space) : spaces().find((s) => s.uuid === ws.activeWorkspace);
    if (!space) throw new Error('Unknown space: ' + a.space);
    const { found, missing } = byIds(a.tabIds);
    const tabs = found.filter((t) => !t.hasAttribute('zen-essential'));
    const skippedEssential = found.filter((t) => t.hasAttribute('zen-essential')).map((t) => t.id);
    ws.moveTabsToWorkspace(tabs, space.uuid);
    await settle();
    let folder = [...w.document.querySelectorAll('zen-folder')].find(
      (f) => f.getAttribute('zen-workspace-id') === space.uuid && f.label === a.folder
    );
    const created = !folder;
    if (folder) {
      for (const t of tabs) if (!t.pinned) gb.pinTab(t);
      folder.addTabs(tabs);
    } else {
      folder = w.gZenFolders.createFolder(tabs, { workspaceId: space.uuid, label: a.folder });
    }
    await settle();
    const inFolder = tabs.filter((t) => folderOf(t)?.label === a.folder).map((t) => t.id);
    return JSON.stringify({ space: space.name, folder: a.folder, created, inFolder, failed: tabs.map((t) => t.id).filter((id) => !inFolder.includes(id)), skippedEssential, missing });
  `),
};

async function browserWindowContext(firefox: any): Promise<string> {
  let result;
  try {
    result = await firefox.sendBiDiCommand('browsingContext.getTree', { 'moz:scope': 'chrome' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('UnsupportedOperationError')) {
      throw new Error(SYSTEM_ACCESS_ERROR);
    }
    throw error;
  }
  const ctx = (result.contexts || []).find((c: any) =>
    String(c.url).startsWith('chrome://browser/content/browser.xhtml')
  );
  if (!ctx) {
    throw new Error('No Zen browser window found in privileged contexts');
  }
  return ctx.context;
}

export async function runZen<T>(script: string, arg: Record<string, unknown> = {}): Promise<T> {
  const { getFirefox } = await import('../index.js');
  const firefox = await getFirefox();
  const context = await browserWindowContext(firefox);
  const result = await firefox.sendBiDiCommand('script.callFunction', {
    functionDeclaration: script,
    awaitPromise: true,
    arguments: [{ type: 'string', value: JSON.stringify(arg) }],
    target: { context },
  });
  if (result.type !== 'success') {
    throw new Error(`Zen script failed: ${result.exceptionDetails?.text ?? 'unknown error'}`);
  }
  const value = result.result.type === 'string' ? result.result.value : undefined;
  if (typeof value !== 'string') {
    throw new Error('Zen script returned no data');
  }
  return JSON.parse(value) as T;
}

const DAY_MS = 86_400_000;

export function ageDays(lastAccessed: number, now = Date.now()): number {
  return lastAccessed ? Math.floor((now - lastAccessed) / DAY_MS) : -1;
}

export interface TabFilter {
  space?: string | undefined;
  staleDays?: number | undefined;
  query?: string | undefined;
  includeEssentials?: boolean | undefined;
  includePinned?: boolean | undefined;
}

export function filterTabs(
  tabs: ZenTab[],
  spaces: ZenSpace[],
  f: TabFilter,
  now = Date.now()
): ZenTab[] {
  let spaceId: string | undefined;
  if (f.space) {
    const key = f.space.toLowerCase();
    const space =
      spaces.find((s) => s.id === f.space) ?? spaces.find((s) => s.name.toLowerCase() === key);
    if (!space) {
      throw new Error(`Unknown space: ${f.space}. Known: ${spaces.map((s) => s.name).join(', ')}`);
    }
    spaceId = space.id;
  }
  const q = f.query?.toLowerCase();
  return tabs.filter(
    (t) =>
      (spaceId === undefined || t.spaceId === spaceId) &&
      (f.includeEssentials !== false || !t.essential) &&
      (f.includePinned !== false || !t.pinned) &&
      (f.staleDays === undefined || ageDays(t.lastAccessed, now) >= f.staleDays) &&
      (!q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function formatTab(t: ZenTab, spaceNames: Map<string, string>, now = Date.now()): string {
  const flags =
    [t.essential && 'E', t.pinned && 'P', t.selected && '*'].filter(Boolean).join('') || '-';
  const where =
    (t.spaceId ? (spaceNames.get(t.spaceId) ?? t.spaceId) : '?') + (t.folder ? `/${t.folder}` : '');
  const age = ageDays(t.lastAccessed, now);
  return `${t.id} | ${where} | ${flags} | ${age < 0 ? '?' : age + 'd'} | ${clip(t.title, 70)} | ${clip(t.url, 120)}`;
}

export const listSpacesTool = {
  name: 'zen_list_spaces',
  description: 'List Zen Spaces with their ids, folders and tab counts.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {} },
} satisfies ToolDefinition;

export const listTabsTool = {
  name: 'zen_list_tabs',
  description:
    'List Zen tabs across all Spaces, including unloaded tabs. One line per tab: id | space[/folder] | flags (E=essential, P=pinned, *=selected) | days since last access | title | url. Use the ids with zen_move_tabs, zen_move_to_folder and zen_close_tabs.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      space: { type: 'string', description: 'Only tabs in this Space (name or id)' },
      staleDays: {
        type: 'number',
        description: 'Only tabs not accessed for at least this many days',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring matched against title and url',
      },
      includeEssentials: { type: 'boolean', description: 'Include Essentials (default true)' },
      includePinned: { type: 'boolean', description: 'Include pinned tabs (default true)' },
      limit: { type: 'number', description: 'Max lines to return (default 200)' },
      offset: { type: 'number', description: 'Skip this many matching tabs (default 0)' },
      saveTo: {
        type: ['boolean', 'string'],
        description:
          'Save all matching tabs as JSON to a file instead of listing them. A path, a directory, or true for ~/.firefox-devtools-mcp/output/.',
      },
    },
  },
} satisfies ToolDefinition;

export const createSpaceTool = {
  name: 'zen_create_space',
  description:
    'Create a Zen Space without switching to it. Returns the existing Space if one has the same name.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Space name' },
      icon: { type: 'string', description: 'Optional emoji or icon for the Space' },
      allowDuplicate: {
        type: 'boolean',
        description: 'Create even if a Space with this name exists',
      },
    },
    required: ['name'],
  },
} satisfies ToolDefinition;

export const moveTabsTool = {
  name: 'zen_move_tabs',
  description: 'Move tabs (by id from zen_list_tabs) to a Zen Space. Essentials are skipped.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      tabIds: { type: 'array', items: { type: 'string' }, description: 'Tab ids' },
      space: { type: 'string', description: 'Target Space name or id' },
    },
    required: ['tabIds', 'space'],
  },
} satisfies ToolDefinition;

export const moveToFolderTool = {
  name: 'zen_move_to_folder',
  description:
    'Put tabs into a Zen folder in a Space, creating the folder if it does not exist. Folders live in the pinned section, so the tabs become pinned. Essentials are skipped.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      tabIds: { type: 'array', items: { type: 'string' }, description: 'Tab ids' },
      folder: { type: 'string', description: 'Folder name' },
      space: { type: 'string', description: 'Space name or id (default: active Space)' },
    },
    required: ['tabIds', 'folder'],
  },
} satisfies ToolDefinition;

export const closeTabsTool = {
  name: 'zen_close_tabs',
  description:
    'Close tabs by id. Before closing, writes a JSON archive (title, url, space, folder) of the tabs and returns its path. Use dryRun to preview. Essentials and pinned tabs are kept unless includePinned is true.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      tabIds: { type: 'array', items: { type: 'string' }, description: 'Tab ids' },
      dryRun: { type: 'boolean', description: 'Only report what would be closed (default false)' },
      includePinned: {
        type: 'boolean',
        description: 'Also close pinned tabs and Essentials (default false)',
      },
      archiveTo: {
        type: 'string',
        description: 'Archive file or directory (default: ~/.firefox-devtools-mcp/output/)',
      },
    },
    required: ['tabIds'],
  },
} satisfies ToolDefinition;

function requireIds(args: { tabIds?: unknown }): string[] {
  const ids = args.tabIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
    throw new Error('tabIds must be a non-empty array of tab id strings');
  }
  return ids;
}

const listLine = (label: string, ids: string[]) =>
  ids.length ? `${label} (${ids.length}): ${ids.join(', ')}` : '';

const lines = (...parts: string[]) => parts.filter(Boolean).join('\n');

export const handleListSpaces = defineToolHandler(async (): Promise<McpToolResponse> => {
  const spaces = await runZen<ZenSpace[]>(SCRIPTS.listSpaces);
  return successResponse(
    lines(
      `${spaces.length} spaces`,
      ...spaces.map(
        (s) =>
          `${s.id} | ${s.icon ? s.icon + ' ' : ''}${s.name} | ${s.tabCount} tabs${s.folders.length ? ` | folders: ${s.folders.join(', ')}` : ''}`
      )
    )
  );
});

export const handleListTabs = defineToolHandler(async (args: unknown): Promise<McpToolResponse> => {
  const a = (args ?? {}) as TabFilter & {
    limit?: number;
    offset?: number;
    saveTo?: boolean | string;
  };
  // Sequential on purpose: concurrent first calls would each open a Marionette session.
  const spaces = await runZen<ZenSpace[]>(SCRIPTS.listSpaces);
  const tabs = await runZen<ZenTab[]>(SCRIPTS.listTabs);
  const now = Date.now();
  const matching = filterTabs(tabs, spaces, a, now).sort((x, y) => x.lastAccessed - y.lastAccessed);
  const names = new Map(spaces.map((s) => [s.id, s.name]));

  if (a.saveTo && FIXED_OUTPUT) {
    throw new Error(
      'Saving the list to a file is switched off in this setup. Use query, staleDays, limit and offset.'
    );
  }
  if (a.saveTo) {
    const data = matching.map((t) => ({
      ...t,
      space: t.spaceId ? (names.get(t.spaceId) ?? null) : null,
    }));
    const saved = await saveOutput(
      JSON.stringify(data, null, 2),
      a.saveTo === true ? undefined : a.saveTo,
      'zen-tabs'
    );
    return successResponse(`${matching.length} of ${tabs.length} tabs saved to: ${saved.path}`);
  }

  const offset = Math.max(0, a.offset ?? 0);
  const limit = Math.max(1, a.limit ?? 200);
  const page = matching.slice(offset, offset + limit);
  const rest = matching.length - offset - page.length;
  return successResponse(
    lines(
      `${matching.length} of ${tabs.length} tabs match (oldest first), showing ${page.length} from offset ${offset}`,
      ...page.map((t) => formatTab(t, names, now)),
      rest > 0 ? `... ${rest} more. Use offset=${offset + page.length} or saveTo.` : ''
    )
  );
});

export const handleCreateSpace = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const { name, icon, allowDuplicate } = (args ?? {}) as {
      name?: string;
      icon?: string;
      allowDuplicate?: boolean;
    };
    if (!name || typeof name !== 'string') {
      throw new Error('name is required');
    }
    const r = await runZen<{ id: string; name: string; created: boolean }>(SCRIPTS.createSpace, {
      name,
      icon,
      allowDuplicate: !!allowDuplicate,
    });
    return successResponse(
      `${r.created ? 'Created' : 'Space already exists:'} ${r.name} (${r.id})`
    );
  }
);

export const handleMoveTabs = defineToolHandler(async (args: unknown): Promise<McpToolResponse> => {
  const a = (args ?? {}) as { tabIds?: unknown; space?: string };
  const tabIds = requireIds(a);
  if (!a.space) {
    throw new Error('space is required');
  }
  const r = await runZen<{
    space: string;
    moved: string[];
    already: string[];
    skippedEssential: string[];
    failed: string[];
    missing: string[];
  }>(SCRIPTS.moveTabs, { tabIds, space: a.space });
  return successResponse(
    lines(
      `Moved ${r.moved.length} tab(s) to ${r.space}`,
      listLine('Already there', r.already),
      listLine('Skipped Essentials', r.skippedEssential),
      listLine('Failed', r.failed),
      listLine('Unknown ids', r.missing)
    )
  );
});

export const handleMoveToFolder = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as { tabIds?: unknown; folder?: string; space?: string };
    const tabIds = requireIds(a);
    if (!a.folder) {
      throw new Error('folder is required');
    }
    const r = await runZen<{
      space: string;
      folder: string;
      created: boolean;
      inFolder: string[];
      failed: string[];
      skippedEssential: string[];
      missing: string[];
    }>(SCRIPTS.moveToFolder, { tabIds, folder: a.folder, space: a.space });
    return successResponse(
      lines(
        `${r.created ? 'Created folder' : 'Added to folder'} ${r.space}/${r.folder}: ${r.inFolder.length} tab(s)`,
        listLine('Skipped Essentials', r.skippedEssential),
        listLine('Failed', r.failed),
        listLine('Unknown ids', r.missing)
      )
    );
  }
);

export const handleCloseTabs = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as {
      tabIds?: unknown;
      dryRun?: boolean;
      includePinned?: boolean;
      archiveTo?: string;
    };
    const tabIds = requireIds(a);
    const spaces = await runZen<ZenSpace[]>(SCRIPTS.listSpaces);
    const found = await runZen<{ tabs: ZenTab[]; missing: string[] }>(SCRIPTS.tabsByIds, {
      tabIds,
    });
    const names = new Map(spaces.map((s) => [s.id, s.name]));
    const kept = a.includePinned ? [] : found.tabs.filter((t) => t.pinned || t.essential);
    const toClose = found.tabs.filter((t) => !kept.includes(t));
    const keptLine = listLine(
      'Kept pinned/Essential',
      kept.map((t) => t.id)
    );
    const missingLine = listLine('Unknown ids', found.missing);

    if (a.dryRun) {
      return successResponse(
        lines(
          `Dry run: would close ${toClose.length} tab(s)`,
          ...toClose.map((t) => formatTab(t, names)),
          keptLine,
          missingLine
        )
      );
    }
    if (toClose.length === 0) {
      return successResponse(lines('Nothing to close', keptLine, missingLine));
    }

    const archive = {
      closedAt: new Date().toISOString(),
      tabs: toClose.map((t) => ({
        title: t.title,
        url: t.url,
        space: t.spaceId ? (names.get(t.spaceId) ?? null) : null,
        folder: t.folder,
        lastAccessed: t.lastAccessed ? new Date(t.lastAccessed).toISOString() : null,
      })),
    };
    const saved = await saveOutput(
      JSON.stringify(archive, null, 2),
      FIXED_OUTPUT ? undefined : a.archiveTo,
      'zen-closed-tabs'
    );
    const r = await runZen<{ closed: string[]; stillOpen: string[] }>(SCRIPTS.closeTabs, {
      tabIds: toClose.map((t) => t.id),
    });
    return successResponse(
      lines(
        `Closed ${r.closed.length} tab(s). Archive: ${saved.path}`,
        listLine('Still open', r.stillOpen),
        keptLine,
        missingLine
      )
    );
  }
);

export const module = defineModule({
  name: 'zen',
  description: 'Organize Zen Browser Spaces, folders and tabs.',
  privileged: true,
  tools: [
    [listSpacesTool, handleListSpaces],
    [listTabsTool, handleListTabs],
    [createSpaceTool, handleCreateSpace],
    [moveTabsTool, handleMoveTabs],
    [moveToFolderTool, handleMoveToFolder],
    [closeTabsTool, handleCloseTabs],
    [viewTool, handleView],
    [splitViewTool, handleSplitView],
    [unsplitViewTool, handleUnsplitView],
  ],
});
