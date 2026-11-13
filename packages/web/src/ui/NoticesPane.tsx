/**
 * Notices (docs/notices.md): what your accounts and services told you, newest first, each with the tier triage gave
 * it and why. A row opens to all its reasons, Open (its link), Mark read and the marks. Opening one from a
 * notification marks it read, here and on the service. Loaded the first time Notices opens (Notices.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { TIER_LABEL } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { askNoticesAgain, loadNotices, markNotice, noticesPage, readNotice, unreadNotices } from '../notices.ts';
import { noticesBoot, toast } from '../state.ts';
import { Empty } from './bits.tsx';
import { Icon } from './icons.tsx';
import { accessLine } from './Notices.tsx';

const SOURCES: Record<string, string> = { github: 'GitHub', telegram: 'Telegram' };
const sourceName = (s: string) => SOURCES[s] ?? s;
const tierOf = (n: P.NoticeView) => n.triage?.decision ?? null;
const tierLabel = (t: P.TriageDecision | null) => (!t ? 'Not decided yet' : t === 'silent' ? 'Muted' : TIER_LABEL[t]);

export function NoticesPane({ focus, onBack }: { focus?: string; onBack?: () => void }) {
  const page = noticesPage.value;
  const [open, setOpen] = useState<string | null>(focus ?? null);
  useEffect(() => void loadNotices(), []);
  // The notice a tap opened: once it is in the list (it may have come after the list was fetched), open, read and shown.
  const here = !!focus && !!page?.items.some((n) => n.id === focus);
  useEffect(() => {
    if (!focus) return;
    setOpen(focus);
    if (!here) {
      if (page) void loadNotices();
      return;
    }
    if (page?.items.find((n) => n.id === focus)?.unread) void readNotice(focus).catch(() => {});
    document.querySelector(`[data-notice="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focus, here]);
  const items = page?.items ?? [];
  const unread = unreadNotices(page).length;
  const access = page?.access ?? noticesBoot.value?.access ?? 'unreachable';
  return (
    <section class="pane requests-pane notices-pane" aria-label="Notices">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon requests-icon">
          <Icon name="bell" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>Notices</h2>
          <div class="conv-head-sub">
            <span class="muted-label">{unread ? `${unread} unread` : items.length ? 'All read' : 'Nothing yet'}</span>
          </div>
        </div>
      </header>
      <div class="requests-scroll">
        {access !== 'granted' && <Access access={access} managerUrl={page?.managerUrl ?? null} />}
        {access === 'granted' && !items.length && (
          <Empty icon="bell" title="Nothing yet">
            What GitHub and your other accounts tell you, and dither-accounts' own word about an account that needs you, lands here, ranked with your chats.
          </Empty>
        )}
        {items.map((n) => (
          <NoticeRow key={n.id} n={n} open={open === n.id} focused={focus === n.id} onToggle={() => setOpen(open === n.id ? null : n.id)} />
        ))}
      </div>
    </section>
  );
}

function Access({ access, managerUrl }: { access: P.NoticeAccessState; managerUrl: string | null }) {
  return (
    <Empty icon="bellOff" title={accessLine(access)}>
      {access === 'pending' && managerUrl && (
        <a href={managerUrl} target="_blank" rel="noopener noreferrer">
          Open dither-accounts
        </a>
      )}
      {access === 'denied' && (
        <button class="chip-btn" onClick={() => askNoticesAgain().catch((e) => toast({ kind: 'error', title: 'Notices', body: String(e?.message ?? e) }))}>
          Ask again
        </button>
      )}
    </Empty>
  );
}

function NoticeRow({ n, open, focused, onToggle }: { n: P.NoticeView; open: boolean; focused: boolean; onToggle: () => void }) {
  const tier = tierOf(n);
  const reasons = n.triage?.reasons ?? [];
  const marks = n.triage?.marks ?? {};
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<unknown>) => async (e: Event) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await f();
    } catch (err: any) {
      toast({ kind: 'error', title: 'Notices', body: String(err?.message ?? err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <article class={`request-card notice-card ${n.unread ? 'unread' : ''} ${focused ? 'focused' : ''} ${busy ? 'busy' : ''}`} data-notice={n.id} data-tier={tier ?? ''} data-urgency={n.urgency}>
      <button class="notice-head" onClick={onToggle} aria-expanded={open}>
        <span class={`notice-dot ${n.unread ? '' : 'read'}`} aria-label={n.unread ? 'Unread' : undefined} />
        <span class="notice-text">
          <span class="notice-where">
            {sourceName(n.source)}
            {n.context ? ` · ${n.context}` : ''} · {ago(n.at)}
          </span>
          <span class="notice-title">{n.title}</span>
          {n.body && <span class="notice-body">{n.body}</span>}
          <span class="notice-why">
            <span class={`notice-tier tier-${tier ?? 'none'}`}>{tierLabel(tier)}</span> {reasons[0] ?? ''}
          </span>
        </span>
      </button>
      {open && (
        <div class="notice-more">
          {reasons.length > 1 && (
            <ul class="notice-reasons">
              {reasons.map((r) => (
                <li>{r}</li>
              ))}
            </ul>
          )}
          <div class="notice-actions">
            {n.url && (
              <a class="chip-btn" href={n.url} target="_blank" rel="noopener noreferrer" onClick={() => n.unread && void readNotice(n.id).catch(() => {})}>
                <Icon name="external" size={13} /> Open
              </a>
            )}
            {n.unread && (
              <button class="chip-btn" data-act="read" onClick={run(() => readNotice(n.id))}>
                <Icon name="check" size={13} /> Mark read
              </button>
            )}
            {tier && tier !== 'silent' && (
              <>
                <button class={`chip-btn ${marks.less ? 'on' : ''}`} data-act="less" onClick={run(() => markNotice(n.id, { less: !marks.less }))}>
                  Less like this
                </button>
                {tier === 'push' ? (
                  <button class={`chip-btn ${marks.alert === false ? 'on' : ''}`} data-act="wrong" onClick={run(() => markNotice(n.id, { alert: marks.alert === false ? null : false }))}>
                    Alert was wrong
                  </button>
                ) : (
                  <button class={`chip-btn ${marks.alert === true ? 'on' : ''}`} data-act="alert" onClick={run(() => markNotice(n.id, { alert: marks.alert === true ? null : true }))}>
                    Should have alerted
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
