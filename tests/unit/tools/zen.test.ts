import { describe, it, expect } from 'vitest';
import {
  ageDays,
  filterTabs,
  formatTab,
  type ZenSpace,
  type ZenTab,
} from '../../../src/tools/zen.js';

const NOW = Date.UTC(2026, 9, 31);
const DAY = 86_400_000;

const spaces: ZenSpace[] = [
  { id: '{a}', name: 'Default', icon: null, folders: [], tabCount: 2 },
  { id: '{b}', name: 'AI', icon: null, folders: ['Papers'], tabCount: 1 },
];

const tab = (over: Partial<ZenTab>): ZenTab => ({
  id: 't',
  title: 'Title',
  url: 'https://example.com/',
  spaceId: '{a}',
  folder: null,
  pinned: false,
  essential: false,
  selected: false,
  lastAccessed: NOW,
  ...over,
});

const tabs = [
  tab({
    id: 'old',
    title: 'GitHub repo',
    url: 'https://github.com/x',
    lastAccessed: NOW - 120 * DAY,
  }),
  tab({ id: 'ess', essential: true, pinned: true, lastAccessed: NOW - 200 * DAY }),
  tab({
    id: 'ai',
    spaceId: '{b}',
    folder: 'Papers',
    title: 'arXiv paper',
    lastAccessed: NOW - 3 * DAY,
  }),
];

describe('filterTabs', () => {
  it('filters by space name case-insensitively or by id', () => {
    expect(filterTabs(tabs, spaces, { space: 'ai' }, NOW).map((t) => t.id)).toEqual(['ai']);
    expect(filterTabs(tabs, spaces, { space: '{a}' }, NOW).map((t) => t.id)).toEqual([
      'old',
      'ess',
    ]);
  });

  it('throws with the known space names for an unknown space', () => {
    expect(() => filterTabs(tabs, spaces, { space: 'Bike' }, NOW)).toThrow(
      'Unknown space: Bike. Known: Default, AI'
    );
  });

  it('combines staleness, query and pinned/essential exclusions', () => {
    expect(filterTabs(tabs, spaces, { staleDays: 90 }, NOW).map((t) => t.id)).toEqual([
      'old',
      'ess',
    ]);
    expect(
      filterTabs(tabs, spaces, { staleDays: 90, includeEssentials: false }, NOW).map((t) => t.id)
    ).toEqual(['old']);
    expect(filterTabs(tabs, spaces, { includePinned: false }, NOW).map((t) => t.id)).toEqual([
      'old',
      'ai',
    ]);
    expect(filterTabs(tabs, spaces, { query: 'GITHUB.COM' }, NOW).map((t) => t.id)).toEqual([
      'old',
    ]);
  });
});

describe('formatTab', () => {
  const names = new Map(spaces.map((s) => [s.id, s.name]));

  it('shows space, folder, flags and age', () => {
    expect(formatTab(tabs[2], names, NOW)).toBe(
      'ai | AI/Papers | - | 3d | arXiv paper | https://example.com/'
    );
    expect(formatTab(tabs[1], names, NOW)).toContain('| Default | EP | 200d |');
  });

  it('clips long titles and marks unknown age', () => {
    const line = formatTab(tab({ title: 'x'.repeat(100), lastAccessed: 0 }), names, NOW);
    expect(line).toContain('x'.repeat(69) + '…');
    expect(line).toContain('| ? |');
  });
});

describe('ageDays', () => {
  it('floors to whole days', () => {
    expect(ageDays(NOW - 1.9 * DAY, NOW)).toBe(1);
  });
});
