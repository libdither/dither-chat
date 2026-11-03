/**
 * Applying the theme, and choosing one. The themes themselves are data in ../themes.ts.
 *
 * The chosen theme is either one theme, or "system": a dark and a light theme, picked by the device's
 * prefers-color-scheme. Hovering (or focusing) a theme in a picker shows it on the whole app until the
 * pointer leaves the list; clicking keeps it.
 */
import { effect, signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, themeById, tokens, type Theme } from '../themes.ts';
import { prefs, setPrefs } from '../state.ts';
import { phone } from '../phone.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';

/** A theme shown for a moment, while the pointer is over it in a picker. */
export const previewTheme = signal<string | null>(null);

const lightQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const systemLight = signal(!!lightQuery?.matches);
lightQuery?.addEventListener('change', () => (systemLight.value = lightQuery.matches));

export const followsSystem = () => prefs.value.theme === 'system';

/** The theme the prefs choose right now, without any preview. */
export function chosenTheme(): Theme {
  const p = prefs.value;
  if (p.theme === 'system') return themeById(systemLight.value ? (p.themeLight ?? DEFAULT_LIGHT) : (p.themeDark ?? DEFAULT_DARK));
  return themeById(p.theme);
}

/** index.html applies this before any script runs, so a reload never flashes the wrong colours. */
const CACHE_KEY = 'dither-chat:theme-vars';

function apply(t: Theme, keep: boolean) {
  const root = document.documentElement;
  const vars = tokens(t);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = t.scheme;
  root.dataset.themeId = t.id;
  // The browser's own frame (the installed app's title bar, Android's status bar) matches the top of the app.
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = phone.value ? t.c.sidebar : vars['--titlebar'];
  if (keep)
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ scheme: t.scheme, css: root.style.cssText }));
    } catch {}
}

if (typeof document !== 'undefined') {
  effect(() => {
    const preview = previewTheme.value;
    apply(preview ? themeById(preview) : chosenTheme(), !preview);
  });
}

/** Choosing a theme: with "system" on, it replaces the dark or the light one, whichever it is. */
export function chooseTheme(t: Theme) {
  previewTheme.value = null;
  if (followsSystem()) setPrefs(t.scheme === 'dark' ? { themeDark: t.id } : { themeLight: t.id });
  else setPrefs({ theme: t.id });
}

function setFollowSystem(on: boolean) {
  previewTheme.value = null;
  if (on) {
    const now = chosenTheme();
    // Keep what you see now as one of the pair.
    setPrefs({ theme: 'system', ...(now.scheme === 'dark' ? { themeDark: now.id } : { themeLight: now.id }) });
  } else setPrefs({ theme: chosenTheme().id });
}

/** A tiny drawing of the app in a theme: the rail, the list, and a conversation with its accent. */
export function Swatch({ t }: { t: Theme }) {
  const c = t.c;
  return (
    <span
      class="theme-swatch"
      aria-hidden="true"
      style={{ '--sw-rail': c.rail, '--sw-side': c.sidebar, '--sw-center': c.center, '--sw-text': c.text, '--sw-dim': c.textDim, '--sw-accent': c.accentFill ?? c.accent, '--sw-border': c.border } as any}
    >
      <span class="sw-rail" />
      <span class="sw-side">
        <i />
        <i />
      </span>
      <span class="sw-center">
        <i />
        <i />
        <b />
      </span>
    </span>
  );
}

/** Every theme, by scheme, with the switch for following the system. Used by the title bar's dropdown, its phone sheet and Settings. */
export function ThemeList({ onChosen, compact }: { onChosen?: () => void; compact?: boolean }) {
  const p = prefs.value;
  const sys = followsSystem();
  const current = chosenTheme().id;
  // Hover previews only with a mouse or pen: on touch, a tap is the choice.
  const hover = (id: string | null, e?: PointerEvent) => {
    if (e && e.pointerType === 'touch') return;
    previewTheme.value = id;
  };
  useEffect(() => () => void (previewTheme.value = null), []);
  const isOn = (t: Theme) => (sys ? (t.scheme === 'dark' ? themeById(p.themeDark).id : themeById(p.themeLight).id) === t.id : current === t.id);
  return (
    <div class={`theme-list ${compact ? 'compact' : ''}`} onPointerLeave={(e) => hover(null, e)}>
      <div class="theme-mode" role="radiogroup" aria-label="Theme mode">
        <button role="radio" aria-checked={!sys} class={`chip-btn ${!sys ? 'on' : ''}`} onClick={() => setFollowSystem(false)}>
          One theme
        </button>
        <button role="radio" aria-checked={sys} class={`chip-btn ${sys ? 'on' : ''}`} onClick={() => setFollowSystem(true)}>
          Match the system
        </button>
      </div>
      {(['dark', 'light'] as const).map((scheme) => (
        <section class="theme-group" aria-label={scheme === 'dark' ? 'Dark themes' : 'Light themes'}>
          <div class="theme-group-head">
            {scheme === 'dark' ? 'Dark' : 'Light'}
            {sys && <span>{scheme === 'dark' ? 'when the system is dark' : 'when the system is light'}</span>}
          </div>
          <div class="theme-opts">
            {THEMES.filter((t) => t.scheme === scheme).map((t) => (
              <button
                class={`theme-opt ${isOn(t) ? 'on' : ''}`}
                aria-pressed={isOn(t)}
                title={t.description}
                onPointerEnter={(e) => hover(t.id, e)}
                onFocus={() => hover(t.id)}
                onBlur={() => hover(null)}
                onClick={() => {
                  chooseTheme(t);
                  onChosen?.();
                }}
              >
                <Swatch t={t} />
                <span class="theme-opt-text">
                  <b>{t.name}</b>
                  {!compact && <small>{t.description}</small>}
                </span>
                {isOn(t) && <Icon name="check" size={15} class="theme-check" />}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The title bar's theme button: a dropdown on a desktop, a sheet on a phone. */
export function ThemeButton({ class: cls }: { class?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || phone.value) return;
    const down = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div class={`theme-anchor ${cls ?? ''}`} ref={box}>
      <button class={`tb-btn ${open ? 'on' : ''}`} title={`Theme: ${chosenTheme().name}`} aria-label="Theme" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="palette" size={16} />
      </button>
      {open &&
        (phone.value ? (
          <Sheet onClose={() => setOpen(false)} label="Theme" tall>
            <ThemeList />
          </Sheet>
        ) : (
          <div class="theme-pop" role="dialog" aria-label="Theme">
            <ThemeList compact />
          </div>
        ))}
    </div>
  );
}
