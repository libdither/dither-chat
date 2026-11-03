/**
 * Every theme, in one place. Each is a palette of the tokens below; ui/Themes.tsx turns the chosen one into CSS
 * variables on <html>, and styles.css only ever reads the variables. To refine a theme, change its colours here;
 * to add one, copy a theme and give it a new id. test/themes.test.ts checks every theme for readable contrast
 * (WCAG AA, 4.5:1, for body, muted and accent text), so run `bun test` after a change.
 *
 * Only the first block of a palette is required. The optional tokens have sensible defaults (see `tokens`):
 * text on a coloured fill is picked for contrast, links follow the accent, code follows the surfaces.
 */
import { contrast, mix, readableOn } from './color.ts';

export interface Palette {
  /** Behind everything; also what shows while the app loads. */
  bg: string;
  /** The column of servers and folders on the left. */
  rail: string;
  /** The list of conversations. */
  sidebar: string;
  /** The conversation itself. */
  center: string;
  /** Cards, chips, menus and inline code: one step up from the center. */
  raised: string;
  hover: string;
  /** The selected row. */
  active: string;
  /** Text fields. */
  input: string;
  border: string;
  borderSoft: string;
  /** Body text, secondary text (previews, labels), and the faintest text (times, hints). All three must stay readable. */
  text: string;
  textDim: string;
  textFaint: string;
  /** The theme's colour, used as text: links, mentions, the selected tab. Must read on the center. */
  accent: string;
  /** A quiet tint of the accent: selected rows, mention pills. */
  accentSoft: string;
  danger: string;
  good: string;
  warn: string;
  /** A message that mentions you: its background tint and the bar on its left. */
  mentionBg: string;
  mentionBorder: string;

  /** The app's top bar, which is also the installed app's title bar and the browser's theme colour. Default: rail. */
  titlebar?: string;
  /** Solid accent behind text: the send button, primary buttons. Default: accent. */
  accentFill?: string;
  /** Text on accentFill. Default: white or near-black, whichever reads better. */
  onAccent?: string;
  /** Default: accent. */
  link?: string;
  /** Your own name in a message (on mentionBg). Default: warn. */
  mentionText?: string;
  dangerBg?: string;
  onDanger?: string;
  onWarn?: string;
  /** Search hits. Default: mentionBg. */
  highlight?: string;
  codeBg?: string;
  codeInline?: string;
  codeText?: string;
  scrollbar?: string;
  scrollbarHover?: string;
  /** An unread conversation's name. Default: text. */
  unread?: string;
  shadow?: string;
  /** Behind a dialog. */
  overlay?: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  scheme: 'dark' | 'light';
  c: Palette;
}

export const THEMES: Theme[] = [
  {
    id: 'dither-dark',
    name: 'Dither dark',
    description: 'The default: quiet blue-grey with a lilac accent',
    scheme: 'dark',
    c: {
      bg: '#0e0f14',
      rail: '#0a0b0f',
      sidebar: '#14161d',
      center: '#171920',
      raised: '#1d2029',
      hover: '#22252f',
      active: '#2a2e3a',
      input: '#0e0f14',
      border: '#262a35',
      borderSoft: '#1e212b',
      text: '#e7e9ef',
      textDim: '#a7adbe',
      textFaint: '#9095a6',
      accent: '#b79bff',
      accentSoft: '#2a2550',
      danger: '#f2626f',
      good: '#5ccf8f',
      warn: '#f2b84e',
      mentionBg: '#3a2f1a',
      mentionBorder: '#6b531f',
      dangerBg: '#2a1518',
    },
  },
  {
    id: 'dither-light',
    name: 'Dither light',
    description: 'The default light: white pages, a dark rail, violet accent',
    scheme: 'light',
    c: {
      bg: '#eef0f4',
      rail: '#1a1d26',
      sidebar: '#f7f8fb',
      center: '#ffffff',
      raised: '#f2f4f8',
      hover: '#eaedf3',
      active: '#e1e6f0',
      input: '#ffffff',
      border: '#d9dde6',
      borderSoft: '#e6e9f0',
      text: '#1a1d26',
      textDim: '#535a6d',
      textFaint: '#5f6577',
      accent: '#6a46d6',
      accentSoft: '#e9e2ff',
      danger: '#c8323f',
      good: '#17804a',
      warn: '#94600f',
      mentionBg: '#fff6df',
      mentionBorder: '#f0d492',
      dangerBg: '#fbe9ea',
      titlebar: '#1a1d26',
    },
  },
  {
    id: 'discord-dark',
    name: 'Discord dark',
    description: "Discord's classic dark grey, blurple and all",
    scheme: 'dark',
    c: {
      bg: '#1e1f22',
      rail: '#1e1f22',
      sidebar: '#2b2d31',
      center: '#313338',
      raised: '#2b2d31',
      hover: '#2e3035',
      active: '#404249',
      input: '#383a40',
      border: '#3f4147',
      borderSoft: '#393b40',
      text: '#dbdee1',
      textDim: '#b5bac1',
      textFaint: '#a9afb6',
      accent: '#a5acff',
      accentFill: '#5865f2',
      accentSoft: '#3c4270',
      link: '#00a8fc',
      danger: '#fa777c',
      good: '#3ecf7b',
      warn: '#f0b232',
      mentionBg: '#3e3a2f',
      mentionBorder: '#f0b232',
      dangerBg: '#3d2a2e',
      codeInline: '#2b2d31',
      codeBg: '#2b2d31',
      scrollbar: '#1a1b1e',
    },
  },
  {
    id: 'discord-onyx',
    name: 'Discord Onyx',
    description: "Discord's near-black, for OLED screens at night",
    scheme: 'dark',
    c: {
      bg: '#000000',
      rail: '#000000',
      sidebar: '#0d0d0f',
      center: '#070709',
      raised: '#141417',
      hover: '#18181c',
      active: '#232328',
      input: '#141417',
      border: '#26262c',
      borderSoft: '#18181c',
      text: '#e3e3e8',
      textDim: '#b2b3bb',
      textFaint: '#8f909a',
      accent: '#a5acff',
      accentFill: '#5865f2',
      accentSoft: '#22264a',
      link: '#00a8fc',
      danger: '#fa777c',
      good: '#3ecf7b',
      warn: '#f0b232',
      mentionBg: '#2a2414',
      mentionBorder: '#f0b232',
      dangerBg: '#2a1416',
    },
  },
  {
    id: 'discord-light',
    name: 'Discord light',
    description: "Discord's light theme: soft greys, blurple buttons",
    scheme: 'light',
    c: {
      bg: '#e3e5e8',
      rail: '#e3e5e8',
      sidebar: '#f2f3f5',
      center: '#ffffff',
      raised: '#f2f3f5',
      hover: '#ebedef',
      active: '#d7dade',
      input: '#ebedef',
      border: '#d4d7dc',
      borderSoft: '#e3e5e8',
      text: '#313338',
      textDim: '#4e5058',
      textFaint: '#5c5e66',
      accent: '#4752c4',
      accentFill: '#5865f2',
      accentSoft: '#e6e8fd',
      link: '#0063d3',
      danger: '#c62f34',
      good: '#1a7f45',
      warn: '#8f5b00',
      mentionBg: '#fdf5e2',
      mentionBorder: '#f0b232',
      dangerBg: '#fbe6e7',
    },
  },
  {
    id: 'amoled',
    name: 'AMOLED black',
    description: 'True black everywhere, to save a phone battery',
    scheme: 'dark',
    c: {
      bg: '#000000',
      rail: '#000000',
      sidebar: '#000000',
      center: '#000000',
      raised: '#111114',
      hover: '#141418',
      active: '#212127',
      input: '#0a0a0c',
      border: '#232328',
      borderSoft: '#16161a',
      text: '#ededf0',
      textDim: '#b4b6bf',
      textFaint: '#8b8e99',
      accent: '#b79bff',
      accentSoft: '#211a3d',
      danger: '#f2626f',
      good: '#5ccf8f',
      warn: '#f2b84e',
      mentionBg: '#2b2210',
      mentionBorder: '#6b531f',
      dangerBg: '#240f12',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic slate with frost blue, calm and low glare',
    scheme: 'dark',
    c: {
      bg: '#242933',
      rail: '#242933',
      sidebar: '#2a2f3a',
      center: '#2e3440',
      raised: '#353c4a',
      hover: '#3b4252',
      active: '#434c5e',
      input: '#272c36',
      border: '#3b4252',
      borderSoft: '#353b47',
      text: '#eceff4',
      textDim: '#d8dee9',
      textFaint: '#b4bccc',
      accent: '#8fc6d5',
      accentSoft: '#3a4b5c',
      link: '#8fbcbb',
      danger: '#e58f97',
      good: '#a3be8c',
      warn: '#ebcb8b',
      mentionBg: '#40403f',
      mentionBorder: '#ebcb8b',
      dangerBg: '#47333a',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Dark purple-grey with pink, purple and neon green',
    scheme: 'dark',
    c: {
      bg: '#191a21',
      rail: '#191a21',
      sidebar: '#21222c',
      center: '#282a36',
      raised: '#313343',
      hover: '#343746',
      active: '#44475a',
      input: '#1e1f29',
      border: '#3a3c4e',
      borderSoft: '#303241',
      text: '#f8f8f2',
      textDim: '#d0d3e6',
      textFaint: '#adb5dc',
      accent: '#c29bfa',
      accentSoft: '#433868',
      link: '#8be9fd',
      danger: '#ff6e6e',
      good: '#50fa7b',
      warn: '#ffb86c',
      mentionBg: '#3d3c35',
      mentionBorder: '#f1fa8c',
      mentionText: '#f1fa8c',
      dangerBg: '#40283a',
      codeText: '#f1fa8c',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: 'Soothing pastels on a deep blue-grey base',
    scheme: 'dark',
    c: {
      bg: '#11111b',
      rail: '#11111b',
      sidebar: '#181825',
      center: '#1e1e2e',
      raised: '#262637',
      hover: '#2a2b3d',
      active: '#313244',
      input: '#181825',
      border: '#313244',
      borderSoft: '#26263a',
      text: '#cdd6f4',
      textDim: '#bac2de',
      textFaint: '#979db6',
      accent: '#cba6f7',
      accentSoft: '#3a3150',
      link: '#89b4fa',
      danger: '#f38ba8',
      good: '#a6e3a1',
      warn: '#fab387',
      mentionBg: '#38333a',
      mentionBorder: '#f9e2af',
      mentionText: '#f9e2af',
      dangerBg: '#3a2636',
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    description: 'The light Catppuccin: warm paper with mauve',
    scheme: 'light',
    c: {
      bg: '#dce0e8',
      rail: '#dce0e8',
      sidebar: '#e6e9ef',
      center: '#eff1f5',
      raised: '#e6e9ef',
      hover: '#e2e5ec',
      active: '#ccd0da',
      input: '#f8f9fb',
      border: '#ccd0da',
      borderSoft: '#dce0e8',
      text: '#4c4f69',
      textDim: '#4a4d66',
      textFaint: '#54576d',
      accent: '#7a2ee0',
      accentFill: '#8839ef',
      accentSoft: '#e4d6fb',
      link: '#1556d6',
      danger: '#c00e34',
      good: '#2c721d',
      warn: '#9a4a00',
      mentionBg: '#f6e8cf',
      mentionBorder: '#df8e1d',
      dangerBg: '#f5d9df',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox dark',
    description: 'Retro warm browns with yellow and orange',
    scheme: 'dark',
    c: {
      bg: '#1d2021',
      rail: '#1d2021',
      sidebar: '#232526',
      center: '#282828',
      raised: '#32302f',
      hover: '#363230',
      active: '#45403d',
      input: '#1d2021',
      border: '#3c3836',
      borderSoft: '#32302f',
      text: '#ebdbb2',
      textDim: '#d5c4a1',
      textFaint: '#b8ab97',
      accent: '#fabd2f',
      accentSoft: '#4a3d1e',
      link: '#83a598',
      danger: '#fd5d48',
      good: '#b8bb26',
      warn: '#fe8019',
      mentionBg: '#43302a',
      mentionBorder: '#fe8019',
      dangerBg: '#3c1f1b',
      codeText: '#8ec07c',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Muted purple night with rose, gold and foam',
    scheme: 'dark',
    c: {
      bg: '#12101c',
      rail: '#12101c',
      sidebar: '#1f1d2e',
      center: '#191724',
      raised: '#26233a',
      hover: '#21202e',
      active: '#34314a',
      input: '#12101c',
      border: '#2f2c44',
      borderSoft: '#24223a',
      text: '#e0def4',
      textDim: '#c4c1dd',
      textFaint: '#9e9ab5',
      accent: '#c4a7e7',
      accentSoft: '#352f4d',
      link: '#9ccfd8',
      danger: '#eb6f92',
      good: '#9ccfd8',
      warn: '#f6c177',
      mentionBg: '#352b2e',
      mentionBorder: '#f6c177',
      mentionText: '#ebbcba',
      dangerBg: '#3a2333',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Deep navy with neon city blues and magenta',
    scheme: 'dark',
    c: {
      bg: '#13131a',
      rail: '#13131a',
      sidebar: '#16161e',
      center: '#1a1b26',
      raised: '#1f2335',
      hover: '#222436',
      active: '#292e42',
      input: '#16161e',
      border: '#292e42',
      borderSoft: '#1f2335',
      text: '#c0caf5',
      textDim: '#a9b1d6',
      textFaint: '#8d95bc',
      accent: '#7aa2f7',
      accentSoft: '#283456',
      link: '#7dcfff',
      danger: '#f7768e',
      good: '#9ece6a',
      warn: '#e0af68',
      mentionBg: '#302c2b',
      mentionBorder: '#e0af68',
      dangerBg: '#372230',
      codeText: '#bb9af7',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized light',
    description: 'Warm cream paper with the classic Solarized hues',
    scheme: 'light',
    c: {
      bg: '#e4ddc8',
      rail: '#e4ddc8',
      sidebar: '#eee8d5',
      center: '#fdf6e3',
      raised: '#f3ecd8',
      hover: '#efe8d3',
      active: '#e2dbc5',
      input: '#fffbef',
      border: '#dbd3bc',
      borderSoft: '#e8e1cc',
      text: '#073642',
      textDim: '#475e66',
      textFaint: '#4b6167',
      accent: '#1c679c',
      accentFill: '#268bd2',
      accentSoft: '#dde6e4',
      danger: '#b42826',
      good: '#4f5c00',
      warn: '#7f5f00',
      mentionBg: '#f6e7bb',
      mentionBorder: '#b58900',
      dangerBg: '#f6dccf',
      codeText: '#a3381a',
    },
  },
  {
    id: 'high-contrast-dark',
    name: 'High contrast dark',
    description: 'Black, white and bright yellow, with strong borders',
    scheme: 'dark',
    c: {
      bg: '#000000',
      rail: '#000000',
      sidebar: '#000000',
      center: '#000000',
      raised: '#121212',
      hover: '#1f1f1f',
      active: '#333333',
      input: '#000000',
      border: '#9a9a9a',
      borderSoft: '#6b6b6b',
      text: '#ffffff',
      textDim: '#f0f0f0',
      textFaint: '#d4d4d4',
      accent: '#ffd400',
      accentSoft: '#3d3300',
      link: '#7fd4ff',
      danger: '#ff7b7b',
      good: '#5dff98',
      warn: '#ffd400',
      mentionBg: '#3d3300',
      mentionBorder: '#ffd400',
      dangerBg: '#3d0f0f',
      scrollbar: '#9a9a9a',
    },
  },
  {
    id: 'high-contrast-light',
    name: 'High contrast light',
    description: 'White pages, black text, deep blue accent',
    scheme: 'light',
    c: {
      bg: '#ffffff',
      rail: '#ebebeb',
      sidebar: '#ffffff',
      center: '#ffffff',
      raised: '#f0f0f0',
      hover: '#e6e6e6',
      active: '#d6d6d6',
      input: '#ffffff',
      border: '#4d4d4d',
      borderSoft: '#8a8a8a',
      text: '#000000',
      textDim: '#1a1a1a',
      textFaint: '#3b3b3b',
      accent: '#0033b3',
      accentSoft: '#dbe4ff',
      danger: '#b00000',
      good: '#00602a',
      warn: '#704c00',
      mentionBg: '#fff0b3',
      mentionBorder: '#704c00',
      dangerBg: '#ffe0e0',
      scrollbar: '#4d4d4d',
    },
  },
];

export const DEFAULT_DARK = 'dither-dark';
export const DEFAULT_LIGHT = 'dither-light';

/** Old prefs said only "dark" or "light". */
export function themeById(id: string | undefined): Theme {
  const legacy = id === 'dark' ? DEFAULT_DARK : id === 'light' ? DEFAULT_LIGHT : id;
  return THEMES.find((t) => t.id === legacy) ?? THEMES[0];
}

/** What a theme's colours are drawn against, for the contrast checks: its three main surfaces. */
export const surfacesOf = (c: Palette) => [c.center, c.sidebar, c.raised];

/** Network colours (protocol's NETWORK_META), which show as text on chips and crumbs. */
export const NETWORK_COLORS = ['#5865F2', '#3A91F5', '#0DBD8B', '#1DAA61'];

/** A chip's background: the network colour at 14% over the surface (styles.css .source-chip). */
const tint = (net: string, surface: string, p: number) => mix(net, surface, p);

/**
 * How much of the network colour a network's name keeps when written as text: as much as reads at 4.5:1 on
 * every surface, the rest is the theme's text colour (color-mix in styles.css).
 */
export function netInk(c: Palette): number {
  for (let p = 100; p >= 0; p -= 5) {
    const ok = NETWORK_COLORS.every((n) => {
      const ink = mix(n, c.text, p / 100);
      return surfacesOf(c).every((s) => contrast(ink, s) >= 4.5 && contrast(ink, tint(n, s, 0.16)) >= 4.5);
    });
    if (ok) return p;
  }
  return 0;
}

/** Every CSS variable a theme sets. */
export function tokens(t: Theme): Record<string, string> {
  const c = t.c;
  const dark = t.scheme === 'dark';
  const fill = c.accentFill ?? c.accent;
  const bar = c.titlebar ?? c.rail;
  // A rail far darker than the list (Dither light's) gets buttons and ink of its own; otherwise it shares the list's.
  const ownRail = contrast(c.textDim, c.rail) < 4.5;
  const railInk = ownRail ? readableOn(c.rail, ['#b5bac8', '#535a6d']) : c.textDim;
  return {
    '--bg': c.bg,
    '--bg-rail': c.rail,
    '--bg-sidebar': c.sidebar,
    '--bg-center': c.center,
    '--bg-raised': c.raised,
    '--bg-hover': c.hover,
    '--bg-active': c.active,
    '--bg-input': c.input,
    '--border': c.border,
    '--border-soft': c.borderSoft,
    '--text': c.text,
    '--text-dim': c.textDim,
    '--text-faint': c.textFaint,
    '--accent': c.accent,
    '--accent-soft': c.accentSoft,
    '--accent-fill': fill,
    '--on-accent': c.onAccent ?? readableOn(fill),
    '--link': c.link ?? c.accent,
    '--mention-bg': c.mentionBg,
    '--mention-border': c.mentionBorder,
    '--mention-text': c.mentionText ?? c.warn,
    '--danger': c.danger,
    '--danger-bg': c.dangerBg ?? mix(c.danger, c.center, 0.14),
    '--on-danger': c.onDanger ?? readableOn(c.danger),
    '--good': c.good,
    '--warn': c.warn,
    '--on-warn': c.onWarn ?? readableOn(c.warn),
    '--highlight': c.highlight ?? c.mentionBg,
    '--code-bg': c.codeBg ?? c.input,
    '--code-inline': c.codeInline ?? c.raised,
    '--code-text': c.codeText ?? c.text,
    '--scrollbar': c.scrollbar ?? c.border,
    '--scrollbar-hover': c.scrollbarHover ?? c.textFaint,
    '--unread': c.unread ?? c.text,
    '--rail-btn': ownRail ? mix(railInk, c.rail, 0.12) : c.sidebar,
    '--rail-ink': railInk,
    '--rail-active': ownRail ? fill : c.accentSoft,
    '--rail-active-ink': ownRail ? (c.onAccent ?? readableOn(fill)) : c.text,
    '--titlebar': bar,
    '--titlebar-text': contrast(c.text, bar) >= 4.5 ? c.text : readableOn(bar, ['#e7e9ef', '#1a1d26']),
    '--shadow': c.shadow ?? (dark ? '0 10px 40px -8px rgba(0, 0, 0, 0.6)' : '0 10px 40px -10px rgba(20, 24, 40, 0.22)'),
    '--overlay': c.overlay ?? (dark ? 'rgb(0 0 0 / 0.55)' : 'rgb(15 18 30 / 0.35)'),
    '--net-ink': `${netInk(c)}%`,
  };
}
