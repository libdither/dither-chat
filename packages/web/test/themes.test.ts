import { describe, expect, test } from 'bun:test';
import { contrast, mix, oklch } from '../src/color.ts';
import { netInk, THEMES, themeById, tokens, NETWORK_COLORS } from '../src/themes.ts';
import { AVATAR_L, AVATAR_C } from '../src/format.ts';

const AA = 4.5;

/** Every pair a theme draws text with, and where. */
function pairs(id: string): [string, string, string][] {
  const t = themeById(id);
  const c = t.c;
  const v = tokens(t);
  const out: [string, string, string][] = [];
  for (const [surf, bg] of [
    ['center', c.center],
    ['sidebar', c.sidebar],
    ['raised', c.raised],
    ['hover', c.hover],
    ['active', c.active],
  ])
    for (const [name, fg] of [
      ['text', c.text],
      ['textDim', c.textDim],
      ['textFaint', c.textFaint],
    ])
      out.push([`${name} on ${surf}`, fg, bg]);
  for (const [name, fg] of [
    ['accent', c.accent],
    ['link', v['--link']],
    ['danger', c.danger],
    ['good', c.good],
    ['warn', c.warn],
  ]) {
    out.push([`${name} on center`, fg, c.center]);
    out.push([`${name} on sidebar`, fg, c.sidebar]);
  }
  out.push(['accent on accentSoft (mention pill)', c.accent, c.accentSoft]);
  out.push(['text on accentSoft (selected row)', c.text, c.accentSoft]);
  out.push(['mentionText on mentionBg', v['--mention-text'], c.mentionBg]);
  out.push(['text on a message that mentions you', c.text, mix(c.mentionBorder, c.center, 0.14)]);
  out.push(['text on a search hit', c.text, v['--highlight']]);
  out.push(['onAccent on accentFill', v['--on-accent'], v['--accent-fill']]);
  out.push(['onDanger on danger (unread count)', v['--on-danger'], c.danger]);
  out.push(['onWarn on warn', v['--on-warn'], c.warn]);
  out.push(['danger on dangerBg', c.danger, v['--danger-bg']]);
  out.push(['code on inline code', v['--code-text'], v['--code-inline']]);
  out.push(['code on code block', v['--code-text'], v['--code-bg']]);
  out.push(['text on input', c.text, c.input]);
  out.push(['textFaint on input (placeholder)', c.textFaint, c.input]);
  out.push(['text on titlebar', v['--titlebar-text'], v['--titlebar']]);
  out.push(['rail icons on their buttons', v['--rail-ink'], v['--rail-btn']]);
  out.push(['rail icons on the rail (sort button)', v['--rail-ink'], c.rail]);
  out.push(['a hovered or selected rail icon', v['--rail-active-ink'], v['--rail-active']]);
  return out;
}

describe('every theme reads at WCAG AA', () => {
  for (const t of THEMES)
    test(t.name, () => {
      const failing = pairs(t.id)
        .map(([what, fg, bg]) => ({ what, fg, bg, ratio: +contrast(fg, bg).toFixed(2) }))
        .filter((p) => p.ratio < AA);
      expect(failing).toEqual([]);
    });
});

test('network names written as text keep some of their colour and still read', () => {
  for (const t of THEMES) {
    const p = netInk(t.c);
    expect(p).toBeGreaterThan(0);
    for (const n of NETWORK_COLORS) for (const s of [t.c.center, t.c.sidebar, t.c.raised]) expect(contrast(mix(n, t.c.text, p / 100), s)).toBeGreaterThanOrEqual(AA);
  }
});

test('theme ids are unique and both schemes have a choice', () => {
  expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  expect(THEMES.filter((t) => t.scheme === 'dark').length).toBeGreaterThan(3);
  expect(THEMES.filter((t) => t.scheme === 'light').length).toBeGreaterThan(3);
});

test('old prefs map to the Dither themes', () => {
  expect(themeById('dark').id).toBe('dither-dark');
  expect(themeById('light').id).toBe('dither-light');
  expect(themeById('nonsense').id).toBe('dither-dark');
});

test('initials read on every avatar hue', () => {
  for (let h = 0; h < 360; h += 5) expect(contrast('#ffffff', oklch(AVATAR_L, AVATAR_C, h))).toBeGreaterThanOrEqual(AA);
});
