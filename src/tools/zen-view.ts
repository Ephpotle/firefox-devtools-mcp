/**
 * Zen Browser tools for what is on screen: split view and Glance.
 * A WebExtension cannot see either, so these run in Zen's privileged browser
 * window like the other Zen tools.
 */

import { successResponse } from '../utils/response-helpers.js';
import { defineToolHandler, type ToolDefinition } from './module.js';
import { chromeFn, runZen } from './zen.js';
import type { McpToolResponse } from '../types/common.js';

export interface ViewTab {
  id: string;
  tabId: number;
  title: string;
  url: string;
}

export interface ZenView {
  space: string | null;
  selected: ViewTab;
  empty?: boolean;
  split: { layout: string; tabs: ViewTab[] } | null;
  glance: { page: ViewTab; preview: ViewTab } | null;
  otherSplits: { layout: string; tabs: ViewTab[] }[];
}

// Shared by the scripts below; runs after the Zen prelude (w, ws, gb, allTabs, tabUrl, spaces, settle).
const VIEW_PRELUDE = `
  const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
  const tracker = ExtensionParent.apiManager.global.tabTracker;
  const vs = w.gZenViewSplitter, gl = w.gZenGlanceManager;
  if (!vs) throw new Error('This Zen has no split view (gZenViewSplitter not found)');
  const brief = (t) => ({ id: t.id, tabId: tracker.getId(t), title: t.label ?? '', url: tabUrl(t) });
  // A tab by its WebExtension id (a number, as the page tools use) or its Zen id (a string).
  const resolve = (key) => {
    if (typeof key === 'number') { try { return tracker.getTab(key, null); } catch { return null; } }
    return allTabs().find((t) => t.id === key) ?? null;
  };
  const parentOf = (t) => (gl ? gl.getTabOrGlanceParent(t) : t);
  // Zen shows a blank placeholder tab when a new, still empty tab is in front.
  const isEmpty = (t) => t.hasAttribute('zen-empty-tab');
  const groupOf = (t) => vs._data.find((g) => g.tabs.includes(t)) ?? null;
  const describe = (g) => ({ layout: g.gridType, tabs: g.tabs.map(brief) });
  const view = () => {
    const sel = gb.selectedTab, parent = parentOf(sel), group = groupOf(parent);
    return {
      space: spaces().find((s) => s.uuid === ws.activeWorkspace)?.name ?? null,
      selected: brief(sel),
      empty: isEmpty(sel),
      split: group ? describe(group) : null,
      glance: parent.glanceTab ? { page: brief(parent), preview: brief(parent.glanceTab) } : null,
      otherSplits: vs._data.filter((g) => g !== group).map(describe),
    };
  };
`;

const buildScripts = () => ({
  view: chromeFn(`${VIEW_PRELUDE}
    return JSON.stringify(view());
  `),
  split: chromeFn(`${VIEW_PRELUDE}
    const missing = [];
    const tabs = [];
    for (const key of a.tabs) {
      const t = resolve(key);
      if (t) tabs.push(parentOf(t)); else missing.push(key);
    }
    if (missing.length) throw new Error('No such tab: ' + missing.join(', '));
    const current = parentOf(gb.selectedTab);
    // One tab, or only new pages: split with the page in front.
    if (!isEmpty(current) && !tabs.includes(current) && (tabs.length + a.urls.length < 2 || a.tabs.length === 0)) tabs.unshift(current);
    const existing = tabs.filter((t, i) => tabs.indexOf(t) === i);
    // Everything is checked before any new tab is opened, so a refusal leaves nothing behind.
    if (existing.length + a.urls.length < 2) {
      throw new Error(isEmpty(current)
        ? 'The tab in front is an empty new tab, so there is no page to split with. Give two tabs or urls.'
        : 'A split view needs at least two different tabs');
    }
    const joined = existing.map(groupOf).find(Boolean);
    const total = new Set((joined ? joined.tabs : []).concat(existing)).size + a.urls.length;
    if (total > vs.MAX_TABS) {
      throw new Error('A split view holds at most ' + vs.MAX_TABS + ' tabs' + (joined ? '; the one these tabs are in already has ' + joined.tabs.length : '') + '.');
    }
    const unsplittable = existing.filter((t) => t.hidden || t.hasAttribute('zen-essential') || isEmpty(t));
    if (unsplittable.length) {
      throw new Error('These tabs cannot be split (Essentials, or tabs in a Space that is not showing): ' + unsplittable.map((t) => t.label).join(', '));
    }
    // New pages open in the current Space, in the same container (logins) as the page in front.
    const opened = a.urls.map((url) => gb.addTrustedTab(url, { userContextId: current.userContextId || 0 }));
    const unique = existing.concat(opened);
    if (opened.length) await settle(600);
    vs.splitTabs(unique, a.layout);
    await settle(700);
    const group = groupOf(unique[0]);
    if (!group || !unique.every((t) => group.tabs.includes(t))) {
      for (const t of opened) gb.removeTab(t, { animate: false });
      throw new Error('Zen did not split these tabs.');
    }
    return JSON.stringify(view());
  `),
  unsplit: chromeFn(`${VIEW_PRELUDE}
    const target = a.tab === undefined ? parentOf(gb.selectedTab) : resolve(a.tab);
    if (!target) throw new Error('No such tab: ' + a.tab);
    const index = vs._data.findIndex((g) => g.tabs.includes(parentOf(target)));
    if (index < 0) return JSON.stringify({ wasSplit: false, view: view() });
    vs.removeGroup(index);
    await settle(400);
    return JSON.stringify({ wasSplit: true, view: view() });
  `),
});
let cached: ReturnType<typeof buildScripts> | undefined;
const scripts = () => (cached ??= buildScripts());

export const LAYOUTS = { 'side-by-side': 'vsep', stacked: 'hsep', grid: 'grid' } as const;
const LAYOUT_NAMES: Record<string, string> = {
  vsep: 'side by side',
  hsep: 'stacked',
  grid: 'grid',
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const tabLine = (t: ViewTab) => `  [${t.tabId}] ${clip(t.title, 70)} — ${clip(t.url, 120)}`;
const splitLines = (s: { layout: string; tabs: ViewTab[] }) =>
  `${LAYOUT_NAMES[s.layout] ?? s.layout}:\n${s.tabs.map(tabLine).join('\n')}`;

export function formatView(v: ZenView): string {
  return [
    `Space showing: ${v.space ?? 'unknown'}`,
    v.empty
      ? 'An empty new tab is in front: no page is showing.'
      : `Tab in focus:\n${tabLine(v.selected)}`,
    v.split
      ? `It is in a split view, ${splitLines(v.split)}`
      : 'It is not in a split view: one page fills the window.',
    v.glance
      ? `Glance is open: a preview is floating over the page.\n  page underneath:\n  ${tabLine(v.glance.page)}\n  preview on top:\n  ${tabLine(v.glance.preview)}`
      : '',
    v.otherSplits.length
      ? `Other split views (not showing now):\n${v.otherSplits.map(splitLines).join('\n')}`
      : '',
    'The numbers in brackets are the tab ids the page tools use.',
  ]
    .filter(Boolean)
    .join('\n');
}

const TAB_KEY = { type: ['number', 'string'] } as const;

export const viewTool = {
  name: 'zen_view',
  description:
    'What is on screen in Zen: the tab in focus, the other tabs sharing its split view and their layout, and whether a Glance preview is open over the page. Use it when the user refers to "these two pages", "the other pane" or "the preview". Tab ids are the same numbers the page tools use.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {} },
} satisfies ToolDefinition;

export const splitViewTool = {
  name: 'zen_split_view',
  description:
    'Show tabs next to each other in a Zen split view. Give tabs (ids from the page tools or zen_list_tabs), urls to open as new tabs, or both. With a single tab or url, it is split with the page in focus. Tabs must be in the Space that is showing; Essentials cannot be split.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      tabs: { type: 'array', items: TAB_KEY, description: 'Existing tabs to show together' },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Addresses to open in new tabs and include',
      },
      layout: {
        type: 'string',
        enum: Object.keys(LAYOUTS),
        description: 'side-by-side (default), stacked, or grid',
      },
    },
  },
} satisfies ToolDefinition;

export const unsplitViewTool = {
  name: 'zen_unsplit_view',
  description:
    'End a split view: its tabs stay open as ordinary tabs. Without tab, ends the split view in focus.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: { tab: { ...TAB_KEY, description: 'Any tab of the split view to end' } },
  },
} satisfies ToolDefinition;

export interface SplitArgs {
  tabs: (number | string)[];
  urls: string[];
  layout: string;
}

export function splitArgs(args: unknown): SplitArgs {
  const a = (args ?? {}) as { tabs?: unknown; urls?: unknown; layout?: unknown };
  const tabs = a.tabs ?? [];
  const urls = a.urls ?? [];
  if (!Array.isArray(tabs) || !tabs.every((t) => typeof t === 'number' || typeof t === 'string')) {
    throw new Error('tabs must be an array of tab ids');
  }
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) {
    throw new Error('urls must be an array of addresses');
  }
  if (tabs.length + urls.length === 0) {
    throw new Error('Give at least one tab or url');
  }
  const checked = (urls as string[]).map((raw) => {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`Only http and https addresses: ${raw}`);
    }
    return url;
  });
  const layout = LAYOUTS[(a.layout ?? 'side-by-side') as keyof typeof LAYOUTS];
  if (!layout) {
    throw new Error(`layout must be one of: ${Object.keys(LAYOUTS).join(', ')}`);
  }
  return { tabs: tabs as (number | string)[], urls: checked, layout };
}

export const handleView = defineToolHandler(async (): Promise<McpToolResponse> => {
  return successResponse(formatView(await runZen<ZenView>(scripts().view)));
});

export const handleSplitView = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const view = await runZen<ZenView>(scripts().split, { ...splitArgs(args) });
    return successResponse(`Split view opened.\n\n${formatView(view)}`);
  }
);

export const handleUnsplitView = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as { tab?: unknown };
    if (a.tab !== undefined && typeof a.tab !== 'number' && typeof a.tab !== 'string') {
      throw new Error('tab must be a tab id');
    }
    const r = await runZen<{ wasSplit: boolean; view: ZenView }>(scripts().unsplit, { tab: a.tab });
    return successResponse(
      `${r.wasSplit ? 'Split view ended; its tabs are still open.' : 'That tab was not in a split view.'}\n\n${formatView(r.view)}`
    );
  }
);
