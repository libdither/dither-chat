/**
 * A mail frame in the app's theme instead of on the white sheet: formatted plain mail in the reader (HtmlBody.tsx), and
 * the composer's Preview (ComposerCard.tsx). Its own module so the composer's chunk need not carry the reader's.
 */

/** The app's theme for a formatted plain mail, from the page's own variables (themes.ts); again when the theme changes. */
export function themeFrame(f: HTMLIFrameElement, doc: Document): () => void {
  const apply = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, or: string) => css.getPropertyValue(name).trim() || or;
    const scheme = css.colorScheme || 'normal';
    f.style.colorScheme = scheme;
    let el = doc.getElementById('dc-theme');
    if (!el) {
      el = doc.createElement('style');
      el.id = 'dc-theme';
      doc.head.append(el);
    }
    el.textContent =
      `:root{color-scheme:${scheme}}html,body{background:transparent!important;color:${v('--text', '#1f2328')}}` +
      `body{font:14.5px/1.5 ${v('--font', 'sans-serif')}}.dc-mail{padding:0}.dc-mail a{color:${v('--link', '#0b62d6')}}` +
      `.dc-mail blockquote[type=cite]{border-left-color:${v('--border', '#c9d1d9')}!important;color:${v('--text-dim', '#57606a')}}` +
      `.dc-mail code,.dc-mail pre{font-family:${v('--mono', 'monospace')};font-size:.92em;background:${v('--bg-raised', '#f6f8fa')};border-radius:5px}` +
      `.dc-mail code{padding:1px 4px}.dc-mail pre{padding:8px 10px}.dc-mail pre code{padding:0;background:none}` +
      `.dc-mail hr{border:0;border-top:1px solid ${v('--border', '#d0d7de')}}` +
      `.dc-fold{border-color:${v('--border', '#d0d7de')};background:${v('--bg-raised', '#f6f8fa')};color:${v('--text-dim', '#57606a')}}`;
  };
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] });
  return () => mo.disconnect();
}
