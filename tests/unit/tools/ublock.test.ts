import { describe, it, expect } from 'vitest';
import {
  checkFilters,
  formatRule,
  formatStatus,
  ruleOp,
  type UboStatus,
} from '../../../src/tools/ublock.js';

const counts = (blocked: number, allowed: number) => ({
  blocked: { any: blocked, frame: 0, script: 0 },
  allowed: { any: allowed, frame: 0, script: 0 },
});

const status = (over: Partial<UboStatus> = {}): UboStatus => ({
  tabUrl: 'https://www.example.com/a',
  pageHostname: 'www.example.com',
  pageDomain: 'example.com',
  isTrustedSite: false,
  noScripting: false,
  noCosmeticFiltering: false,
  noPopups: false,
  noLargeMedia: false,
  noRemoteFonts: false,
  pageCounts: counts(3, 9),
  hostnameDict: {
    'example.com': { domain: 'example.com', counts: counts(0, 9) },
    'ads.test': { domain: 'ads.test', counts: counts(3, 0) },
    'quiet.test': { domain: 'quiet.test', counts: counts(0, 0) },
  },
  firewallRules: { '. ads.test *': 'www.example.com ads.test * 1' },
  matrixIsDirty: true,
  userFiltersAreEnabled: true,
  advancedUserEnabled: true,
  ...over,
});

describe('ublock tools', () => {
  it('describes rules in words', () => {
    expect(formatRule('. ads.test *', 'www.example.com ads.test * 1')).toBe(
      'block ads.test (on this site)'
    );
    expect(formatRule('/ * 3p-script', '* * 3p-script 3')).toBe('noop 3p-script (on every site)');
  });

  it('lists hosts with most blocked first and leaves out silent ones', () => {
    const text = formatStatus(status());
    expect(text).toContain('3 blocked, 9 allowed');
    expect(text.indexOf('ads.test  3 / 0')).toBeLessThan(text.indexOf('example.com  0 / 9'));
    expect(text).not.toContain('quiet.test');
    expect(text).toContain('temporary changes');
  });

  it('says when advanced mode is off', () => {
    expect(formatStatus(status({ advancedUserEnabled: false }))).toContain('Advanced mode is off');
    expect(formatStatus(status())).not.toContain('Advanced mode is off');
  });

  it('builds rule operations', () => {
    expect(ruleOp({ target: 'ads.test', action: 'block' })).toEqual({
      kind: 'rule',
      target: 'ads.test',
      type: '*',
      action: 1,
      everywhere: false,
    });
    expect(ruleOp({ type: '3p-script', action: 'noop', everywhere: true })).toMatchObject({
      target: '*',
      type: '3p-script',
      action: 3,
      everywhere: true,
    });
  });

  it('refuses rules that are too broad or malformed', () => {
    expect(() => ruleOp({ action: 'block' })).toThrow(/too broad/);
    expect(() => ruleOp({ target: 'ads.test', type: '3p', action: 'block' })).toThrow(/not both/);
    expect(() => ruleOp({ target: 'https://ads.test/x', action: 'block' })).toThrow(/host name/);
    expect(() => ruleOp({ target: 'ads.test', action: 'nuke' })).toThrow(/action/);
  });

  it('only accepts filters tied to a site', () => {
    expect(checkFilters([' example.com##.ad '])).toEqual(['example.com##.ad']);
    expect(() => checkFilters(['##.ad'])).toThrow(/every website/);
    expect(() => checkFilters(['#@#.ad'])).toThrow(/every website/);
    expect(() => checkFilters(['! comment'])).toThrow(/Not a filter/);
    expect(() => checkFilters(['a\nb'])).toThrow(/single/);
    expect(() => checkFilters([])).toThrow();
  });
});
