/** The room the keyboard and the panel in its place take from the app (phone.ts), apart from the page so tests can run it. */

/** The panel's height: the keyboard's, 40% of the screen before one was seen, and never under 200 or over 60%. */
export const clampPanel = (kb: number, screen: number) => Math.round(Math.min(screen * 0.6, Math.max(200, kb || screen * 0.4)));

/**
 * How tall the app is drawn, and whether it counts as "keyboard open" (the tab bar hides). `inner` is the layout's
 * height; `visible` what iOS's visual viewport leaves (else `inner`). Where the app keeps the keyboard's room to the
 * page, the room is the taller of the keyboard and the panel; elsewhere the browser already shrank `inner` for the
 * keyboard, and only the panel's room is taken here. Null height: the full height.
 */
export function appHeight(o: { inner: number; visible: number; typing: boolean; app: boolean; ime: number; panel: number }): { h: number | null; kb: boolean } {
  if (o.app) {
    const room = Math.max(o.ime, o.panel);
    return { h: room > 0 ? Math.round(o.inner - room) : null, kb: room > 0 };
  }
  const base = o.typing && o.visible < o.inner - 1 ? o.visible : o.inner;
  const h = base - o.panel;
  return { h: h < o.inner - 1 ? Math.round(h) : null, kb: o.panel > 0 };
}
