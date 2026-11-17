/**
 * uBlock Origin tools: per-site switches, dynamic filtering rules and "My filters".
 *
 * uBlock Origin offers no API to other programs, so these reach into its
 * background page from the privileged browser window and call the same message
 * handlers its own popup and dashboard use. Requires the moz build and
 * MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.
 */

import { successResponse } from '../utils/response-helpers.js';
import { defineModule, defineToolHandler, type ToolDefinition } from './module.js';
import { runZen } from './zen.js';
import type { McpToolResponse } from '../types/common.js';

export const SWITCHES = [
  'no-scripting',
  'no-cosmetic-filtering',
  'no-popups',
  'no-large-media',
  'no-remote-fonts',
] as const;
export const RULE_TYPES = [
  '*',
  'image',
  '3p',
  'inline-script',
  '1p-script',
  '3p-script',
  '3p-frame',
] as const;
export const ACTIONS = { none: 0, block: 1, allow: 2, noop: 3 } as const;
const ACTION_NAMES = ['none', 'block', 'allow', 'noop'];

interface Counts {
  any: number;
  frame: number;
  script: number;
}

export interface UboStatus {
  tabUrl: string;
  pageHostname: string;
  pageDomain: string;
  isTrustedSite: boolean;
  noScripting: boolean;
  noCosmeticFiltering: boolean;
  noPopups: boolean;
  noLargeMedia: boolean;
  noRemoteFonts: boolean;
  pageCounts?: { blocked: Counts; allowed: Counts };
  hostnameDict: Record<string, { domain: string; counts: { blocked: Counts; allowed: Counts } }>;
  firewallRules: Record<string, string>;
  matrixIsDirty: boolean;
  userFiltersAreEnabled: boolean;
  advancedUserEnabled: boolean;
}

// Runs in the browser window with chrome privileges. `a.op` says what to change;
// the reply is always uBlock's own view of the tab afterwards.
const SCRIPT = `async (argJson) => {
  const a = JSON.parse(argJson);
  const ID = 'uBlock0@raymondhill.net';
  if (!WebExtensionPolicy.getByID(ID)) throw new Error('uBlock Origin is not installed or is switched off in this browser');
  const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
  let bg = null;
  for (const ctx of ExtensionParent.ParentAPIManager.proxyContexts.values()) {
    if (ctx.extension?.id === ID && ctx.viewType === 'background') bg = ctx;
  }
  if (!bg?.xulBrowser) throw new Error('uBlock Origin has no background page yet; try again in a moment');
  const mm = bg.xulBrowser.messageManager;

  // Runs inside uBlock's background page process.
  const frame = function (channel, msg, replyName) {
    const reply = (data) => sendAsyncMessage(replyName, JSON.stringify(data));
    try {
      const win = content.wrappedJSObject;
      const m = win.vAPI.messaging;
      const entry = channel === 'default' ? null : m.listeners.get(channel);
      if (channel !== 'default' && !entry) throw new Error('uBlock has no channel ' + channel);
      const cb = Cu.exportFunction((r) => {
        reply({ ok: true, value: r === undefined ? null : JSON.parse(win.JSON.stringify(r)) });
      }, content);
      const req = Cu.cloneInto(msg, content);
      const sender = Cu.cloneInto({ privileged: true }, content);
      const r = entry ? entry.fn(req, sender, cb) : m.defaultHandler(req, sender, cb);
      if (r === m.UNHANDLED) throw new Error('uBlock did not recognise ' + msg.what);
    } catch (e) {
      reply({ ok: false, error: String(e && e.message || e) });
    }
  };
  let n = 0;
  const call = (channel, msg) => new Promise((resolve, reject) => {
    const replyName = 'ubo-tools:' + Date.now() + ':' + (n++);
    const on = (m) => {
      mm.removeMessageListener(replyName, on);
      clearTimeout(timer);
      const r = JSON.parse(m.data);
      r.ok ? resolve(r.value) : reject(new Error(r.error));
    };
    const timer = setTimeout(() => {
      mm.removeMessageListener(replyName, on);
      reject(new Error('uBlock Origin did not answer (' + msg.what + ')'));
    }, 15000);
    mm.addMessageListener(replyName, on);
    const src = '(' + frame.toString() + ')(' + JSON.stringify(channel) + ',' + JSON.stringify(msg) + ',' + JSON.stringify(replyName) + ')';
    mm.loadFrameScript('data:,' + encodeURIComponent(src), false);
  });

  const w = Services.wm.getMostRecentWindow('navigator:browser');
  if (!w) throw new Error('No browser window');
  const urlOf = (t) => t.linkedBrowser?.currentURI?.spec ?? '';
  let tab = w.gBrowser.selectedTab;
  if (a.tab) {
    const k = String(a.tab).toLowerCase();
    const all = [...(w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs)];
    tab = all.find((t) => urlOf(t).toLowerCase().includes(k));
    if (!tab) throw new Error('No open tab has an address containing: ' + a.tab);
  }
  const tabId = ExtensionParent.apiManager.global.tabTracker.getId(tab);
  const status = async () => Object.assign(await call('popupPanel', { what: 'getPopupData', tabId }), { tabUrl: urlOf(tab) });

  let s = await status();
  if (!s.pageHostname) throw new Error('uBlock Origin has nothing for this tab (' + urlOf(tab) + '). It only works on ordinary web pages.');
  const host = s.pageHostname;
  const op = a.op;
  let extra = null;
  if (op) {
    if (op.kind === 'switch') {
      await call('popupPanel', { what: 'toggleHostnameSwitch', name: op.name, hostname: host, state: op.on, tabId });
    } else if (op.kind === 'rule') {
      if (!s.advancedUserEnabled) throw new Error("uBlock Origin ignores these rules until its 'I am an advanced user' setting is on. Ask the user, then turn it on with ublock_set_advanced_mode.");
      await call('popupPanel', { what: 'toggleFirewallRule', srcHostname: op.everywhere ? '*' : host, desHostname: op.target, requestType: op.type, action: op.action, tabId });
    } else if (op.kind === 'advanced') {
      await call('default', { what: 'userSettings', name: 'advancedUserEnabled', value: op.on });
    } else if (op.kind === 'keep') {
      await call('popupPanel', { what: 'saveFirewallRules', srcHostname: host, desHostnames: s.hostnameDict });
    } else if (op.kind === 'undo') {
      await call('popupPanel', { what: 'revertFirewallRules', srcHostname: host, desHostnames: s.hostnameDict, tabId });
    } else if (op.kind === 'addFilters') {
      await call('default', { what: 'createUserFilter', filters: op.filters.join('\\n'), docURL: s.pageURL, autoComment: true, pageDomain: s.pageDomain });
    } else if (op.kind === 'readFilters' || op.kind === 'removeFilters') {
      const f = await call('dashboard', { what: 'readUserFilters' });
      const have = String(f.content || '').split('\\n');
      if (op.kind === 'readFilters') {
        extra = { filters: have.map((l) => l.trim()).filter(Boolean) };
      } else {
        const drop = new Set(op.filters);
        const removed = have.filter((l) => drop.has(l.trim())).map((l) => l.trim());
        // Also drop the dated comment uBlock put above a removed filter, if nothing else is left under it.
        const gone = have.map((l) => drop.has(l.trim()));
        for (let i = have.length - 1; i >= 0; i--) {
          if (!gone[i] || i === 0 || !have[i - 1].startsWith('!')) continue;
          let j = i + 1;
          while (j < have.length && gone[j]) j++;
          if (j >= have.length || !have[j].trim() || have[j].startsWith('!')) gone[i - 1] = true;
        }
        if (removed.length) {
          await call('dashboard', { what: 'writeUserFilters', content: have.filter((l, i) => !gone[i]).join('\\n'), enabled: f.enabled, trusted: f.trusted });
          await call('default', { what: 'reloadAllFilters' });
        }
        extra = { removed, notFound: op.filters.filter((l) => !removed.includes(l)) };
      }
    }
    s = await status();
  }
  if (a.reload) await call('default', { what: 'reloadTab', tabId, bypassCache: true });
  const keep = ['tabUrl', 'pageHostname', 'pageDomain', 'isTrustedSite', 'noScripting', 'noCosmeticFiltering', 'noPopups', 'noLargeMedia', 'noRemoteFonts', 'pageCounts', 'hostnameDict', 'firewallRules', 'matrixIsDirty', 'userFiltersAreEnabled', 'advancedUserEnabled'];
  return JSON.stringify({ status: Object.fromEntries(keep.map((k) => [k, s[k]])), extra });
}`;

type Op =
  | { kind: 'switch'; name: string; on: boolean }
  | { kind: 'rule'; target: string; type: string; action: number; everywhere: boolean }
  | { kind: 'advanced'; on: boolean }
  | { kind: 'keep' }
  | { kind: 'undo' }
  | { kind: 'addFilters'; filters: string[] }
  | { kind: 'removeFilters'; filters: string[] }
  | { kind: 'readFilters' };

interface Reply {
  status: UboStatus;
  extra: { filters?: string[]; removed?: string[]; notFound?: string[] } | null;
}

const run = (tab: unknown, op?: Op, reload?: unknown) =>
  runZen<Reply>(SCRIPT, {
    tab: typeof tab === 'string' && tab ? tab : undefined,
    op,
    reload: reload === true,
  });

/** "/ * 3p-script" => "everywhere: 3p-script", ". ads.example *" => "this site: ads.example". */
export function formatRule(key: string, value: string): string {
  const [scope, target, type] = key.split(' ');
  const what = target === '*' ? (type === '*' ? 'everything' : type) : target;
  const action = ACTION_NAMES[Number(String(value).trim().split(' ').pop())] ?? String(value);
  return `${action} ${what} (${scope === '/' ? 'on every site' : 'on this site'})`;
}

export function formatStatus(s: UboStatus, maxHosts = 40): string {
  const on = (flag: boolean, label: string) => `${label} ${flag ? 'ON' : 'off'}`;
  const hosts = Object.entries(s.hostnameDict ?? {})
    .map(([hostname, d]) => ({ hostname, b: d.counts.blocked.any, a: d.counts.allowed.any }))
    .filter((h) => h.a + h.b > 0)
    .sort((x, y) => y.b - x.b || y.a - x.a);
  const rules = Object.entries(s.firewallRules ?? {}).map(([k, v]) => '  ' + formatRule(k, v));
  return [
    `Site: ${s.pageHostname} (${s.tabUrl})`,
    s.isTrustedSite
      ? 'uBlock Origin is switched OFF for this site (trusted site): nothing is filtered.'
      : 'uBlock Origin is filtering this site.',
    `Switches: ${[
      on(s.noScripting, 'no-scripting'),
      on(s.noCosmeticFiltering, 'no-cosmetic-filtering'),
      on(s.noPopups, 'no-popups'),
      on(s.noLargeMedia, 'no-large-media'),
      on(s.noRemoteFonts, 'no-remote-fonts'),
    ].join(', ')}`,
    s.advancedUserEnabled
      ? ''
      : 'Advanced mode is off: host and type rules (ublock_set_rule) have no effect until it is turned on with ublock_set_advanced_mode. Switches and My filters work either way.',
    s.pageCounts
      ? `Requests since the page loaded: ${s.pageCounts.blocked.any} blocked, ${s.pageCounts.allowed.any} allowed`
      : '',
    rules.length ? `Rules in effect:\n${rules.join('\n')}` : 'Rules in effect: none',
    s.matrixIsDirty
      ? 'There are temporary changes for this site (lost when the browser restarts unless kept with ublock_keep_changes).'
      : 'No temporary changes for this site.',
    hosts.length
      ? `Hosts contacted (blocked / allowed):\n${hosts
          .slice(0, maxHosts)
          .map((h) => `  ${h.hostname}  ${h.b} / ${h.a}`)
          .join('\n')}${hosts.length > maxHosts ? `\n  … and ${hosts.length - maxHosts} more` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const HOSTNAME = /^(\*|[a-z0-9_-]+(\.[a-z0-9_-]+)*)$/i;

/** One filter per entry, each tied to a site: generic filters would affect every page. */
export function checkFilters(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 20 ||
    !value.every((f) => typeof f === 'string')
  ) {
    throw new Error('filters must be an array of 1 to 20 filter strings');
  }
  return (value as string[]).map((raw) => {
    const f = raw.trim();
    if (!f || /[\r\n]/.test(f)) {
      throw new Error('Each filter must be a single non-empty line');
    }
    if (f.startsWith('!') || f.startsWith('[')) {
      throw new Error(`Not a filter: ${f}`);
    }
    if (/^#[@?$]?#/.test(f)) {
      throw new Error(
        `"${f}" would apply on every website. Put the site in front, e.g. example.com##.ad-banner`
      );
    }
    return f;
  });
}

const TAB_PROP = {
  tab: {
    type: 'string',
    description: 'Part of the address of the tab to act on (default: the tab in front)',
  },
} as const;
const RELOAD_PROP = {
  reload: { type: 'boolean', description: 'Reload the tab afterwards so the change takes effect' },
} as const;

export const statusTool = {
  name: 'ublock_status',
  description:
    'What uBlock Origin is doing on a tab: whether it is on for the site, the per-site switches, the dynamic rules in effect, and every host the page contacted with how many requests were blocked and allowed. Look here before changing anything.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { ...TAB_PROP } },
} satisfies ToolDefinition;

export const setSwitchTool = {
  name: 'ublock_set_switch',
  description:
    "Turn one of uBlock Origin's per-site switches on or off for the tab's site. no-scripting ON blocks all JavaScript on the site; no-cosmetic-filtering ON stops hiding page elements; no-large-media ON blocks large images and video; no-remote-fonts ON blocks web fonts; no-popups ON blocks popup windows. Temporary until the browser restarts unless kept with ublock_keep_changes.",
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      switch: { type: 'string', enum: [...SWITCHES] },
      on: { type: 'boolean' },
      ...RELOAD_PROP,
      ...TAB_PROP,
    },
    required: ['switch', 'on'],
  },
} satisfies ToolDefinition;

export const setRuleTool = {
  name: 'ublock_set_rule',
  description:
    "Set one uBlock Origin dynamic filtering rule for the tab's site. Either name a target host (from ublock_status) to block or allow everything from that host, or leave target out and give a type: 3p (all third-party), 3p-script, 3p-frame, 1p-script, inline-script, image. action: block; noop (stop dynamic rules from blocking it, static filter lists still apply); allow (let it through even past the filter lists — use sparingly); none (remove the rule). Temporary until the browser restarts unless kept with ublock_keep_changes.",
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Host the page loads from, e.g. ads.example.com. Omit to use type instead.',
      },
      type: { type: 'string', enum: RULE_TYPES.filter((t) => t !== '*') },
      action: { type: 'string', enum: Object.keys(ACTIONS) },
      everywhere: {
        type: 'boolean',
        description: 'Apply on every website instead of only this site (default false)',
      },
      ...RELOAD_PROP,
      ...TAB_PROP,
    },
    required: ['action'],
  },
} satisfies ToolDefinition;

export const setAdvancedModeTool = {
  name: 'ublock_set_advanced_mode',
  description:
    "Turn uBlock Origin's 'I am an advanced user' setting on or off. ublock_set_rule only has an effect while it is on. It also makes uBlock's own panel show its per-host rule grid. Permanent until changed back.",
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: { on: { type: 'boolean' }, ...TAB_PROP },
    required: ['on'],
  },
} satisfies ToolDefinition;

export const keepChangesTool = {
  name: 'ublock_keep_changes',
  description:
    "Make the temporary switches and rules for the tab's site permanent, so they survive a browser restart.",
  annotations: { readOnlyHint: false },
  inputSchema: { type: 'object', properties: { ...TAB_PROP } },
} satisfies ToolDefinition;

export const undoChangesTool = {
  name: 'ublock_undo_changes',
  description:
    "Throw away the temporary switches and rules for the tab's site, going back to what was last kept.",
  annotations: { readOnlyHint: false },
  inputSchema: { type: 'object', properties: { ...RELOAD_PROP, ...TAB_PROP } },
} satisfies ToolDefinition;

export const listFiltersTool = {
  name: 'ublock_list_filters',
  description:
    'The lines in uBlock Origin\'s "My filters". Give query to only see lines containing it (e.g. the site\'s domain).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, ...TAB_PROP },
  },
} satisfies ToolDefinition;

export const addFiltersTool = {
  name: 'ublock_add_filters',
  description:
    'Add lines to uBlock Origin\'s "My filters". Permanent (remove with ublock_remove_filters). Each must be tied to a site: a cosmetic filter such as example.com##.ad-banner hides elements; a network filter such as ||tracker.example^$domain=example.com blocks requests; @@||cdn.example^$script,domain=example.com allows them. Prefer ublock_set_rule for anything temporary.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      filters: { type: 'array', items: { type: 'string' }, description: 'One filter per entry' },
      ...RELOAD_PROP,
      ...TAB_PROP,
    },
    required: ['filters'],
  },
} satisfies ToolDefinition;

export const removeFiltersTool = {
  name: 'ublock_remove_filters',
  description:
    'Remove lines from uBlock Origin\'s "My filters". Each entry must match a line exactly (see ublock_list_filters).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      filters: { type: 'array', items: { type: 'string' } },
      ...RELOAD_PROP,
      ...TAB_PROP,
    },
    required: ['filters'],
  },
} satisfies ToolDefinition;

type Args = Record<string, unknown>;
const after = (headline: string, r: Reply, reload: unknown) =>
  successResponse(
    `${headline}${reload === true ? ' The tab is reloading; counts below are from before.' : ' Reload the tab for it to take full effect.'}\n\n${formatStatus(r.status, 15)}`
  );

export const handleStatus = defineToolHandler(async (args: unknown): Promise<McpToolResponse> => {
  const a = (args ?? {}) as Args;
  return successResponse(formatStatus((await run(a.tab)).status));
});

export const handleSetSwitch = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    const name = a.switch as (typeof SWITCHES)[number];
    if (!SWITCHES.includes(name)) {
      throw new Error(`switch must be one of: ${SWITCHES.join(', ')}`);
    }
    if (typeof a.on !== 'boolean') {
      throw new Error('on must be true or false');
    }
    const r = await run(a.tab, { kind: 'switch', name, on: a.on }, a.reload);
    return after(
      `${name} is now ${a.on ? 'ON' : 'off'} for ${r.status.pageHostname} (temporary).`,
      r,
      a.reload
    );
  }
);

export function ruleOp(a: Args): Extract<Op, { kind: 'rule' }> {
  const action = ACTIONS[a.action as keyof typeof ACTIONS];
  if (action === undefined) {
    throw new Error('action must be block, allow, noop or none');
  }
  const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim() : '*';
  const type = typeof a.type === 'string' && a.type ? a.type : '*';
  if (!HOSTNAME.test(target)) {
    throw new Error(`target must be a host name, got: ${target}`);
  }
  if (!RULE_TYPES.includes(type as (typeof RULE_TYPES)[number])) {
    throw new Error(`type must be one of: ${RULE_TYPES.filter((t) => t !== '*').join(', ')}`);
  }
  if (target !== '*' && type !== '*') {
    throw new Error('Give either a target host or a type, not both (uBlock does not combine them)');
  }
  if (target === '*' && type === '*') {
    throw new Error('Give a target host or a type; a rule for everything is too broad');
  }
  return { kind: 'rule', target, type, action, everywhere: a.everywhere === true };
}

export const handleSetRule = defineToolHandler(async (args: unknown): Promise<McpToolResponse> => {
  const a = (args ?? {}) as Args;
  const op = ruleOp(a);
  const r = await run(a.tab, op, a.reload);
  const what = op.target === '*' ? op.type : op.target;
  const where = op.everywhere ? 'every site' : r.status.pageHostname;
  return after(
    op.action === 0
      ? `Removed the rule for ${what} on ${where}.`
      : `Rule set: ${ACTION_NAMES[op.action]} ${what} on ${where} (temporary).`,
    r,
    a.reload
  );
});

export const handleSetAdvancedMode = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    if (typeof a.on !== 'boolean') {
      throw new Error('on must be true or false');
    }
    const r = await run(a.tab, { kind: 'advanced', on: a.on });
    return successResponse(
      `Advanced mode is now ${r.status.advancedUserEnabled ? 'on' : 'off'} in uBlock Origin.`
    );
  }
);

export const handleKeepChanges = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    const r = await run(a.tab, { kind: 'keep' });
    return successResponse(
      `Kept: the switches and rules for ${r.status.pageHostname} are now permanent.\n\n${formatStatus(r.status, 15)}`
    );
  }
);

export const handleUndoChanges = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    const r = await run(a.tab, { kind: 'undo' }, a.reload);
    return after(`Temporary changes for ${r.status.pageHostname} thrown away.`, r, a.reload);
  }
);

export const handleListFilters = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    const r = await run(a.tab, { kind: 'readFilters' });
    const q = typeof a.query === 'string' ? a.query.toLowerCase() : '';
    const all = r.extra?.filters ?? [];
    const shown = (q ? all.filter((l) => l.toLowerCase().includes(q)) : all).slice(0, 300);
    return successResponse(
      shown.length
        ? `${shown.length} of ${all.length} line(s) in My filters${r.status.userFiltersAreEnabled ? '' : ' (My filters is currently switched off in uBlock)'}:\n${shown.join('\n')}`
        : `No ${q ? 'matching ' : ''}lines in My filters (${all.length} in total).`
    );
  }
);

export const handleAddFilters = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    const filters = checkFilters(a.filters);
    const r = await run(a.tab, { kind: 'addFilters', filters }, a.reload);
    return after(
      `Added to My filters (permanent):\n${filters.map((f) => '  ' + f).join('\n')}\n`,
      r,
      a.reload
    );
  }
);

export const handleRemoveFilters = defineToolHandler(
  async (args: unknown): Promise<McpToolResponse> => {
    const a = (args ?? {}) as Args;
    if (!Array.isArray(a.filters) || !a.filters.every((f) => typeof f === 'string')) {
      throw new Error('filters must be an array of filter strings');
    }
    const filters = (a.filters as string[]).map((f) => f.trim()).filter(Boolean);
    const r = await run(a.tab, { kind: 'removeFilters', filters }, a.reload);
    const removed = r.extra?.removed ?? [];
    const notFound = r.extra?.notFound ?? [];
    return successResponse(
      [
        removed.length
          ? `Removed from My filters:\n${removed.map((f) => '  ' + f).join('\n')}`
          : 'Nothing removed.',
        notFound.length
          ? `Not found (must match a line exactly):\n${notFound.map((f) => '  ' + f).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
);

export const module = defineModule({
  name: 'ublock',
  description: 'uBlock per site.',
  privileged: true,
  tools: [
    [statusTool, handleStatus],
    [setSwitchTool, handleSetSwitch],
    [setRuleTool, handleSetRule],
    [setAdvancedModeTool, handleSetAdvancedMode],
    [keepChangesTool, handleKeepChanges],
    [undoChangesTool, handleUndoChanges],
    [listFiltersTool, handleListFilters],
    [addFiltersTool, handleAddFilters],
    [removeFiltersTool, handleRemoveFilters],
  ],
});
