/**
 * The message box's panel on a phone (docs/uploads.md "The panel"): in the keyboard's place and at its height, so
 * swapping one for the other never moves the box (phone.ts openPanel). Tabs along its bottom for what this chat's
 * network takes: Photos and Files (the phone's own, through the Android app, and what your chats already hold),
 * Stickers, Emoji (the box's emoji button opens it here too) and Poll. A chunk of its own, loaded when + is first
 * pressed.
 *
 * What is picked is attached at once, into the row over the box, and uploads while you pick more or write the
 * caption; picking it again takes it back. It can open to the whole screen (a search, every photo).
 */
import { createPortal, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { closePanel, imeHeight, panelHeight, panelOpen, panelShown, useLayer } from '../../phone.ts';
import { toast } from '../../state.ts';
import type { Attached } from '../ComposerFiles.tsx';
import { Icon } from '../icons.tsx';
import { FilesTab } from './Files.tsx';
import { PanelHead } from './parts.tsx';
import { PhotosTab } from './Photos.tsx';
import './panel.css';

export type PanelTab = 'photos' | 'files' | 'stickers' | 'emoji' | 'poll';

/** What the composer lends the panel. */
export interface PanelCtx {
  convId: string;
  network: P.Network | undefined;
  /** "up to 25 MB each" */
  limit: string;
  attached: Attached[];
  add: (files: File[]) => Promise<Attached[]>;
  remove: (key: number) => void;
  /** Where the account sends files; Stickers and Poll show without. */
  canAttach: boolean;
  openCamera: () => void;
  /** The system pickers, only when asked for. */
  pickPhotos: () => void;
  pickFiles: () => void;
  /** The send screen: what is picked, large. */
  openLarge: () => void;
  viewOnce?: { on: boolean; set: (on: boolean) => void };
  /** The tabs the composer draws itself, where the chat has them: the sticker picker, the emoji picker (typing into
   * the box), the poll maker (the box's text as its question). */
  stickers?: () => ComponentChildren;
  emoji?: () => ComponentChildren;
  poll?: () => ComponentChildren;
}

/** The picks: by where they came from (`dev:i12`, `hub:<attachment>`, `file:<path>`), and the row's key they got. */
export interface Picks {
  /** Its place among what is picked (1, 2…), 0 while loading, or null. */
  at: (id: string) => number | null;
  toggle: (id: string, load: () => Promise<File>) => void;
  count: number;
}

function usePicks(ctx: PanelCtx): Picks {
  const [keys, setKeys] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const live = new Set(ctx.attached.map((a) => a.key));
  // Taken out of the row (its ×) or sent: no longer picked.
  const order = ctx.attached.map((a) => a.key);
  const at = (id: string) => {
    if (loading.has(id)) return 0;
    const k = keys.get(id);
    return k !== undefined && live.has(k) ? order.indexOf(k) + 1 : null;
  };
  const toggle = (id: string, load: () => Promise<File>) => {
    const k = keys.get(id);
    if (k !== undefined && live.has(k)) {
      ctx.remove(k);
      setKeys((m) => (m.delete(id), new Map(m)));
      return;
    }
    if (loading.has(id)) return;
    setLoading((s) => new Set(s).add(id));
    load()
      .then((f) => ctx.add([f]))
      .then((added) => {
        const a = added[0];
        if (a?.refused) toast({ kind: 'error', title: `Can't attach ${a.file.name}`, body: a.refused });
        if (a) setKeys((m) => new Map(m).set(id, a.key));
      })
      .catch((e) => toast({ kind: 'error', title: 'Could not read that file', body: String(e?.message ?? e) }))
      .finally(() => setLoading((s) => ((s = new Set(s)), s.delete(id), s)));
  };
  return { at, toggle, count: [...keys.values()].filter((k) => live.has(k)).length };
}

const TABS: { id: PanelTab; icon: string; label: string }[] = [
  { id: 'photos', icon: 'image', label: 'Photos' },
  { id: 'files', icon: 'file', label: 'Files' },
  { id: 'stickers', icon: 'sticker', label: 'Stickers' },
  { id: 'emoji', icon: 'smile', label: 'Emoji' },
  { id: 'poll', icon: 'list', label: 'Poll' },
];

export function Panel({ ctx, tab, setTab }: { ctx: PanelCtx; tab: PanelTab; setTab: (t: PanelTab) => void }) {
  const picks = usePicks(ctx);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayer(() => closePanel());
  // A tap on the chat above closes it (it is a place to read), as it does in Telegram.
  useEffect(() => {
    const h = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest || t.closest('.kp, .composer, .sheet-layer, .modal-backdrop, .menu, .toast, .send-screen, .camera-view')) return;
      closePanel();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, []);
  useEffect(() => setFull(false), [tab]);
  const own = { stickers: ctx.stickers, emoji: ctx.emoji, poll: ctx.poll } as Partial<Record<PanelTab, () => ComponentChildren>>;
  const tabs = TABS.filter((t) => (t.id === 'photos' || t.id === 'files' ? ctx.canAttach : !!own[t.id]));
  // A field of the panel's own (a search, the poll's lines) has the keyboard up: the panel opens to the whole screen
  // above it, so what is typed stays in sight.
  const focusIn = (e: FocusEvent) => {
    const t = e.target as HTMLInputElement;
    if ((t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test(t.type)) || t.tagName === 'TEXTAREA') setFull(true);
  };
  const h = panelHeight();
  const shown = panelShown.value;
  // Open to the whole screen: above the keyboard where the app keeps its room (a search field has the keyboard up).
  const style = full ? { top: 'var(--app-top, 0px)', bottom: `${imeHeight.value}px`, height: 'auto' } : { height: `${h}px`, transform: shown < 1 ? `translateY(${Math.round((1 - shown) * h)}px)` : undefined };
  return createPortal(
    <div class={`kp ${full ? 'full' : ''}`} ref={box} style={style} data-track-area="panel" data-open={panelOpen.value ? '' : undefined} onFocusIn={focusIn}>
      <div class={`kp-body kp-${tab}`}>
        {tab === 'photos' && ctx.canAttach && <PhotosTab ctx={ctx} picks={picks} full={full} setFull={setFull} />}
        {tab === 'files' && ctx.canAttach && <FilesTab ctx={ctx} picks={picks} full={full} setFull={setFull} />}
        {tab !== 'photos' && tab !== 'files' && full && (
          <PanelHead full setFull={(f) => (setFull(f), (document.activeElement as HTMLElement | null)?.blur())} />
        )}
        {tab !== 'photos' && tab !== 'files' && own[tab]?.()}
      </div>
      {!full && (
        <nav class="kp-tabs" role="tablist">
          {tabs.map((t) => (
            <button class={`kp-tab ${t.id === tab ? 'on' : ''}`} role="tab" aria-selected={t.id === tab} data-track={t.id} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={19} />
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </div>,
    document.body,
  );
}
