/**
 * A mail's HTML (docs/mail-design.md §7): the hub's sanitised copy in a frame sandboxed without scripts, on a white
 * sheet in every theme, scaled down to fit the width when the mail is wider than the screen.
 *
 * Nothing runs in the frame. The page reaches into it (same origin, the only thing `allow-same-origin` is for) to size
 * it, fold the quoted part behind ···, catch every click on a link and open it the way chat's links open (a link whose
 * text names another site asks first), and hand touches to the pager so a swipe over the body still goes back.
 * When the frame cannot load (the hub is away), the text part shows instead.
 */
import type * as P from '@dither-chat/protocol';
import { hostsDiffer, shownHost } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { openLink } from '../../desk.ts';
import { bodies } from '../../mail/api.ts';
import { api } from '../../state.ts';
import { mailChanged } from '../../versions.ts';
import { copy, openMenu } from '../ContextMenu.tsx';
import { forwardTouches } from '../Pager.ts';
import { ImageBanner } from './ImageBanner.tsx';
import type { BodyProps } from './slots.tsx';
import { TextBody } from './TextBody.tsx';

/** A link out of a mail, opened as chat's links are: the desktop helper, else a new tab (Android: its browser). */
export function openOut(url: string) {
  void openLink(url).then((ok) => {
    if (ok) return;
    if (/^mailto:/i.test(url)) window.location.assign(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  });
}

/** The quoted part: the top-level quotes the hub marked that nothing but more quotes follows. */
function foldQuotes(doc: Document, wrap: HTMLElement): HTMLElement[] {
  const quotes = [...wrap.querySelectorAll<HTMLElement>('.dc-quote')].filter((q) => !q.parentElement?.closest('.dc-quote'));
  const hide: HTMLElement[] = [];
  for (const q of quotes.reverse()) {
    if (q.dataset.dcQuote === 'rest') {
      for (let n: Element | null = q; n; n = n.nextElementSibling) hide.push(n as HTMLElement);
      continue;
    }
    // Text after it that is not itself quoted: an inline reply, so this quote stays.
    const r = doc.createRange();
    r.setStartAfter(q);
    r.setEnd(wrap, wrap.childNodes.length);
    const after = r.cloneContents();
    after.querySelectorAll('.dc-quote').forEach((x) => x.remove());
    if ((after.textContent ?? '').trim()) break;
    hide.push(q);
  }
  if (!hide.length) return [];
  for (const h of hide) h.classList.add('dc-folded');
  // Nothing would be left to read above it: show it all.
  if (!wrap.innerText.trim()) {
    for (const h of hide) h.classList.remove('dc-folded');
    return [];
  }
  const first = hide.reduce((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? b : a));
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'dc-fold';
  btn.textContent = '···';
  btn.title = 'Show the quoted text';
  btn.setAttribute('aria-expanded', 'false');
  first.before(btn);
  return hide;
}

/** Everything the page does inside a loaded frame; returns how to undo it. */
function host(f: HTMLIFrameElement, doc: Document): () => void {
  const win = doc.defaultView!;
  const wrap = doc.querySelector<HTMLElement>('.dc-mail')!;
  const folded = foldQuotes(doc, wrap);
  let width = 0;
  const fit = () => {
    const W = f.clientWidth;
    width = W;
    if (!W) return;
    wrap.style.transform = '';
    wrap.style.width = '';
    const natural = Math.max(wrap.scrollWidth, doc.documentElement.scrollWidth);
    let k = 1;
    if (natural > W + 1) {
      k = W / natural;
      wrap.style.width = `${natural}px`;
      wrap.style.transformOrigin = '0 0';
      wrap.style.transform = `scale(${k})`;
    }
    f.style.height = `${Math.max(24, Math.ceil(wrap.offsetHeight * k))}px`;
  };

  const click = (e: MouseEvent) => {
    const el = e.target instanceof win.Element ? e.target : ((e.target as Node | null)?.parentElement ?? null);
    const toggle = el?.closest('.dc-fold');
    if (toggle) {
      e.preventDefault();
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('title', open ? 'Hide the quoted text' : 'Show the quoted text');
      for (const h of folded) h.classList.toggle('dc-folded', !open);
      return fit();
    }
    const a = el?.closest<HTMLAnchorElement>('a[href]');
    if (!a) return;
    // Never followed in the frame.
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      doc.getElementById(id)?.scrollIntoView({ block: 'start' });
      return;
    }
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      return;
    }
    if (!/^(https?|mailto):$/.test(url.protocol)) return;
    const shown = url.protocol === 'mailto:' ? null : shownHost(a.textContent ?? '');
    if (shown && hostsDiffer(shown, url.hostname)) {
      const r = f.getBoundingClientRect();
      return openMenu(
        { x: r.left + e.clientX, y: r.top + e.clientY },
        {
          label: 'Open link',
          head: (
            <div class="cm-sheet-title mail-link-ask">
              The link shows {shown} but goes to <b>{url.hostname}</b>
            </div>
          ),
          items: [
            { kind: 'label', label: `Shows ${shown}, goes to ${url.hostname}` },
            { label: `Open ${url.hostname}`, icon: 'external', run: () => openOut(url.href) },
            { label: 'Copy the link', icon: 'copy', run: () => void copy(url.href, 'Link copied') },
          ],
        },
      );
    }
    openOut(url.href);
  };
  const block = (e: Event) => e.preventDefault();
  // The app's keys (Escape, Ctrl+K) work with the focus in the frame too.
  const key = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true }));
  };
  doc.addEventListener('click', click, true);
  doc.addEventListener('auxclick', block, true);
  doc.addEventListener('submit', block, true);
  doc.addEventListener('keydown', key);
  // Images arriving change the height.
  doc.addEventListener('load', fit, true);
  doc.addEventListener('error', fit, true);
  const ro = new ResizeObserver(() => f.clientWidth !== width && fit());
  ro.observe(f);
  const untouch = forwardTouches(f);
  fit();
  // Web fonts and late layout.
  const late = setTimeout(fit, 400);
  return () => {
    clearTimeout(late);
    ro.disconnect();
    untouch();
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('auxclick', block, true);
    doc.removeEventListener('submit', block, true);
    doc.removeEventListener('keydown', key);
    doc.removeEventListener('load', fit, true);
    doc.removeEventListener('error', fit, true);
  };
}

/** Bodies asked of the hub again this session. */
const checked = new Set<string>();

/**
 * A body kept from an earlier session (the offline snapshot) may be stale: images allowed since, on another device or
 * for the sender, or a newer sanitiser. Asked again once, quietly; offline the kept one stays.
 */
function useFresh(messageId: string) {
  useEffect(() => {
    if (checked.has(messageId)) return;
    checked.add(messageId);
    api<P.MailBodyView>(`/api/mail/messages/${encodeURIComponent(messageId)}/body`)
      .then((b) => {
        if (JSON.stringify(b) === JSON.stringify(bodies.get(messageId))) return;
        bodies.set(messageId, b);
        mailChanged();
      })
      .catch(() => checked.delete(messageId));
  }, [messageId]);
}

export function HtmlBody(p: BodyProps) {
  const html = p.body.html!;
  useFresh(p.message.id);
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useLayoutEffect(() => {
    const f = frame.current;
    if (!f) return;
    setState('loading');
    let undo: (() => void) | null = null;
    const loaded = () => {
      undo?.();
      undo = null;
      const doc = f.contentDocument;
      if (!doc?.querySelector('.dc-mail')) {
        // about:blank before the real document, or an error from the hub.
        if (doc && doc.URL !== 'about:blank') setState('failed');
        return;
      }
      undo = host(f, doc);
      setState('ready');
    };
    f.addEventListener('load', loaded);
    if (f.contentDocument?.readyState === 'complete') loaded();
    return () => {
      f.removeEventListener('load', loaded);
      undo?.();
    };
  }, [html.url]);
  if (state === 'failed') return <TextBody {...p} />;
  const from = p.message.from.name || p.message.from.email;
  return (
    <div class={`mail-html ${state}`}>
      <ImageBanner message={p.message} body={p.body} />
      <div class="mail-sheet">
        <iframe ref={frame} key={html.url} class="mail-frame" src={html.url} sandbox="allow-same-origin" referrerpolicy="no-referrer" title={`Mail from ${from}`} />
      </div>
    </div>
  );
}
