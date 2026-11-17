import { describe, it, expect } from 'vitest';
import { formatView, splitArgs, type ZenView } from '../../../src/tools/zen-view.js';

const tab = (tabId: number, title: string) => ({
  id: `z${tabId}`,
  tabId,
  title,
  url: `https://${title.toLowerCase()}.test/`,
});

const view = (over: Partial<ZenView> = {}): ZenView => ({
  space: 'Work',
  selected: tab(1, 'One'),
  split: null,
  glance: null,
  otherSplits: [],
  ...over,
});

describe('zen view tools', () => {
  it('says when one page fills the window', () => {
    const text = formatView(view());
    expect(text).toContain('Space showing: Work');
    expect(text).toContain('[1] One');
    expect(text).toContain('not in a split view');
  });

  it('lists the tabs sharing a split view with their layout', () => {
    const text = formatView(
      view({ split: { layout: 'vsep', tabs: [tab(1, 'One'), tab(2, 'Two')] } })
    );
    expect(text).toContain('side by side');
    expect(text).toContain('[2] Two');
  });

  it('describes an open Glance preview', () => {
    const text = formatView(view({ glance: { page: tab(1, 'One'), preview: tab(3, 'Three') } }));
    expect(text).toContain('Glance is open');
    expect(text).toContain('[3] Three');
  });

  it('normalises split arguments', () => {
    expect(splitArgs({ urls: ['example.com'] })).toEqual({
      tabs: [],
      urls: ['https://example.com'],
      layout: 'vsep',
    });
    expect(splitArgs({ tabs: [4, 'z5'], layout: 'stacked' })).toMatchObject({
      tabs: [4, 'z5'],
      layout: 'hsep',
    });
  });

  it('refuses bad split arguments', () => {
    expect(() => splitArgs({})).toThrow(/at least one/);
    expect(() => splitArgs({ urls: ['file:///c:/x'] })).toThrow(/http/);
    expect(() => splitArgs({ tabs: [1], layout: 'diagonal' })).toThrow(/layout/);
    expect(() => splitArgs({ tabs: [{}] })).toThrow(/tab ids/);
  });
});
