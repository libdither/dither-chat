/**
 * Notification calibration (docs/notifications.md, "Asking, without nagging"): the questions about single
 * notifications, waiting until you get to them, newest first. Each one draws again what you saw, as the hub kept it
 * (seen.ts): the Android notification in the shade, on the lock screen or as a heads-up, with what showed beside it;
 * a browser's notification on a computer; the toast in the open app; or the inbox row when no notification went out.
 * A line says where, whether it sounded and when, and what the hub does not know is said too. Above them, the numbers:
 * sounds a day, what you said of them, how late you answer, and the model's chances against your answers.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORKS } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { clock, hueOf, initials, stamp } from '../format.ts';
import { answerCheckin, askLess, calibration, checkins, loadCheckins } from '../loudness.ts';
import { go } from '../state.ts';
import { Empty, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import { HeadOrb } from './Offline.tsx';
import './calibration.css';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ANSWERS: Record<P.CheckinView['side'], { q: string; answers: [string, string][] }> = {
  sounded: {
    q: 'This sounded. Was it worth it?',
    answers: [
      ['worth', 'Worth it'],
      ['could_wait', 'Could have waited'],
      ['shouldnt', "Shouldn't have reached me"],
    ],
  },
  quiet: {
    q: 'This stayed quiet. Would you have wanted it sooner?',
    answers: [
      ['sooner', "Wish I'd known sooner"],
      ['fine', 'Fine where it was'],
    ],
  },
  foryou: {
    q: 'For you showed you this. Was it worth seeing?',
    answers: [
      ['glad', 'Glad I saw this'],
      ['not', 'Not for me'],
    ],
  },
};

const asNet = (n: string | null | undefined): P.Network | null => (n && (NETWORKS as readonly string[]).includes(n) ? (n as P.Network) : null);

/** "3 h", "2 days": how long, in words for a sentence. */
function age(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  const d = Math.round(ms / DAY);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

const SOURCE: Record<string, string> = {
  notification: 'its notification',
  toast: 'the notification in the app',
  inbox: 'the inbox',
  triage: 'the inbox',
  foryou: 'For you',
  rail: 'the list',
  list: 'the list',
  search: 'search',
  link: 'a link',
  back: 'going back',
  forward: 'going forward',
  start: 'opening the app',
  resume: 'coming back to the app',
};

const SURFACE: Record<P.SeenSurface, string> = {
  heads_up: 'as a heads-up over the screen',
  shade: 'in the notification shade',
  lock: 'on the lock screen',
  list_row: "on the phone's list",
  browser: 'as a browser notification',
  toast: 'in the open app',
};

/** The device you most likely saw it on: the one that said it showed, or was tapped, first. */
function mainDevice(s: P.SeenSent): P.SeenDevice | null {
  const first = (d: P.SeenDevice) => d.tapped ?? d.shown ?? d.dismissed ?? 0;
  const said = s.devices.filter((d) => d.tapped || d.shown || d.dismissed).sort((a, b) => first(a) - first(b));
  return said[0] ?? s.devices.find((d) => d.phone) ?? s.devices[0] ?? null;
}

function soundWord(d: P.SeenDevice | null, s: P.SeenSent): string {
  if (d?.sound === 'sound') return 'sounded';
  if (d?.sound === 'vibrate') return 'vibrated';
  if (d?.sound === 'silent') return d.meantToSound ? 'silent (the device was on silent)' : 'silent';
  return s.sounded ? 'meant to sound' : 'silent';
}

/** One line: "Phone (Pixel), sounded, 14:02, while you were on the computer". */
function summary(c: P.CheckinView, now = Date.now()): string {
  const x = c.context;
  const s = x.sent;
  if (!s) {
    const why = x.notSent === 'watched' ? 'its chat was open on your computer' : x.notSent === 'capped' ? 'one had gone out for this chat minutes before' : 'it waited in the inbox';
    return `No notification: ${why}. It came ${stamp(c.at, now)}.`;
  }
  const d = mainDevice(s);
  const where = d ? `${d.phone ? 'Phone' : 'Computer'} (${d.label})` : 'No device known';
  const parts = [where, soundWord(d, s), stamp(s.at, now)];
  if (d?.surface) parts.push(SURFACE[d.surface]);
  if (s.computerInUse) parts.push('while you were on the computer');
  else if (s.computerInUse === false) parts.push('with no computer in use');
  return parts.join(', ');
}

export function CalibrationPane({ onBack }: { onBack?: () => void }) {
  useEffect(() => void loadCheckins(), []);
  const list = checkins.value;
  const stats = calibration.value;
  const n = list?.length ?? 0;
  return (
    <section class="pane requests-pane calibration-pane" aria-label="Notification calibration">
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
          <h2>Notification calibration</h2>
          <div class="conv-head-sub">
            <span class="muted-label">{list === null ? 'Loading…' : n ? `${n} waiting · answer whenever you like` : 'Nothing waiting'}</span>
          </div>
        </div>
        <HeadOrb />
      </header>
      <div class="requests-scroll calib-scroll">
        {stats && <Numbers s={stats} />}
        {list === null && <Loading label="Loading…" />}
        {list && !list.length && (
          <Empty icon="bell" title="Nothing waiting">
            Now and then a question about one notification lands here: was a sound worth it, should a quiet one have sounded. Your answers teach it what to sound for.
          </Empty>
        )}
        {list?.map((c) => <Question key={c.id} c={c} />)}
        {list && list.length > 0 && (
          <div class="calib-foot">
            <button class="link-btn" data-track="calibration ask less" onClick={() => void askLess()}>
              Ask me less
            </button>
            <span>Questions older than two weeks, or past twenty, go by themselves. Leaving one is not a skip.</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the numbers

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const num = (v: number | null, d = 1) => (v === null ? '–' : v.toFixed(d).replace(/\.0$/, ''));

function Numbers({ s }: { s: P.CalibrationStats }) {
  const days = s.sounds.days;
  const max = Math.max(1, ...days.map((d) => d.n ?? 0));
  return (
    <section class="calib-numbers" aria-label="The numbers">
      <div class="calib-tile" data-stat="sounds">
        <b>{num(s.sounds.last7)}</b>
        <span>sounds a day, last 7 days</span>
        <small>{num(s.sounds.last30)} over 30 days · shown, never a limit</small>
        {days.length > 1 && (
          <svg class="calib-spark" viewBox={`0 0 ${days.length * 6} 24`} preserveAspectRatio="none" aria-hidden="true">
            {days.map((d, i) => (d.n === null ? null : <rect x={i * 6 + 1} y={24 - (22 * d.n) / max} width="4" height={(22 * d.n) / max} rx="1" />))}
          </svg>
        )}
      </div>
      <div class="calib-tile" data-stat="worth">
        <b>{pct(s.worth.value)}</b>
        <span>of sounds were worth it</span>
        <small>{s.worth.n ? `weighted, from ${s.worth.n} random picks` : 'no answers yet'}</small>
      </div>
      <div class="calib-tile" data-stat="missed">
        <b>{pct(s.missed.value)}</b>
        <span>of quiet ones should have sounded</span>
        <small>{s.missed.n ? `weighted, from ${s.missed.n} random picks` : 'no answers yet'}</small>
      </div>
      <div class="calib-tile" data-stat="counts">
        <b>{s.pending}</b>
        <span>waiting</span>
        <small>
          {s.answered} answered, {s.skipped} skipped, {s.expired} dropped (30 days)
        </small>
      </div>
      <div class="calib-tile" data-stat="delay">
        <b>{s.delay.median === null ? '–' : age(s.delay.median)}</b>
        <span>typical wait before you answer</span>
        <small>{s.age.mean === null ? 'no answers yet' : `the message ${age(s.age.mean)} old on average; late answers count a little less`}</small>
      </div>
      <Reliability c={s.calibration} />
    </section>
  );
}

/** The model's chance you wanted it, against your answers: dots on the diagonal are a model that knows. */
function Reliability({ c }: { c: P.CalibrationStats['calibration'] }) {
  const W = 120;
  const at = (v: number) => 4 + v * (W - 8);
  return (
    <div class="calib-tile calib-rel" data-stat="calibration">
      <span>Its chances against your answers</span>
      {c.n ? (
        <>
          <svg viewBox={`0 0 ${W} ${W}`} width={W} height={W} role="img" aria-label={`Calibration from ${c.n} answers`}>
            <rect x="4" y="4" width={W - 8} height={W - 8} class="calib-rel-frame" />
            <line x1={at(0)} y1={at(1)} x2={at(1)} y2={at(0)} class="calib-rel-diag" />
            {c.bins.map((b) => (
              <circle cx={at(b.predicted)} cy={at(1 - b.observed)} r={Math.min(9, 3 + Math.sqrt(b.n) * 1.5)} class="calib-rel-dot">
                <title>{`It said ${pct(b.predicted)}; you said yes to ${pct(b.observed)} of ${b.n}`}</title>
              </circle>
            ))}
          </svg>
          <small>
            Across: what it gave. Up: how often you said yes. {c.n} answers{c.brier !== null ? `, Brier ${c.brier.toFixed(2)}` : ''}.
          </small>
        </>
      ) : (
        <small>Shown once you have answered some.</small>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one question

function Question({ c }: { c: P.CheckinView }) {
  const s = ANSWERS[c.side];
  const now = Date.now();
  const x = c.context;
  const devices = x.sent?.devices ?? [];
  // Draw each place it showed: the Android app and computers' browsers; a page's toast. At least one picture.
  const drawn = devices.filter((d) => d.shown || d.tapped || d.dismissed || d.delivered);
  return (
    <article class="calib-q" data-checkin={c.side} data-checkin-id={c.id} aria-label="A question about a notification">
      <header class="calib-q-head">
        <Icon name={c.side === 'sounded' ? 'bell' : c.side === 'quiet' ? 'bellOff' : 'sparkles'} size={15} />
        <b>{s.q}</b>
        <span class="calib-age" title={`Asked ${stamp(c.askedAt, now)}`}>
          {age(now - c.at)} ago{now - c.at > 3 * DAY ? ' · think back' : ''}
        </span>
      </header>
      <p class="calib-line" data-summary>
        {summary(c, now)}
      </p>
      <div class="calib-mocks">
        {x.sent && drawn.map((d) => <DeviceMock c={c} s={x.sent!} d={d} />)}
        {x.sent && !drawn.length && <DeviceMock c={c} s={x.sent} d={devices.find((d) => d.phone) ?? devices[0] ?? null} />}
        {(!x.sent || x.forYou || c.side === 'quiet') && <InAppMock c={c} />}
      </div>
      <ul class="calib-facts">
        {devices.map((d) => (
          <li>{deviceFact(d)}</li>
        ))}
        {x.opened && (
          <li>
            You opened the chat {stamp(x.opened.at, now)} from {SOURCE[x.opened.source] ?? x.opened.source}, on {x.opened.phone ? 'the phone' : 'a computer'} ({x.opened.device}).
          </li>
        )}
        {x.forYou && (
          <li>
            For you served it {x.forYou.position + 1}
            {ordinal(x.forYou.position + 1)} on the page, {stamp(x.forYou.servedAt, now)}
            {x.forYou.shownAt ? `; on screen${x.forYou.ms ? ` for ${Math.max(1, Math.round(x.forYou.ms / 1000))} s` : ''}` : ''}.
          </li>
        )}
        {c.note && <li>{c.note[0].toUpperCase() + c.note.slice(1)}.</li>}
      </ul>
      {x.unknown.length > 0 && (
        <div class="calib-unknown">
          <b>What we don't know</b>
          <ul>
            {x.unknown.map((u) => (
              <li>{u}</li>
            ))}
          </ul>
        </div>
      )}
      <div class="calib-answers">
        {s.answers.map(([a, label]) => (
          <button class="chip-btn" data-answer={a} data-track={`checkin ${a}`} onClick={() => void answerCheckin(c, a)}>
            {label}
          </button>
        ))}
      </div>
      <div class="calib-q-foot">
        <button class="link-btn" data-track="checkin skip" onClick={() => void answerCheckin(c, null)}>
          Skip
        </button>
        {c.conversationId && (
          <button class="link-btn" data-track="checkin open chat" onClick={() => go({ view: 'inbox', conv: c.conversationId!, msg: c.messageId })}>
            Open the chat
          </button>
        )}
      </div>
    </article>
  );
}

const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'));

function deviceFact(d: P.SeenDevice): string {
  const name = `${d.label} (${d.kind === 'android' ? 'Android app' : d.kind === 'browser' ? (d.phone ? "phone's browser" : 'browser') : 'open app'})`;
  if (d.suppressed) return `${name}: not shown, the app was open in front at ${clock(d.suppressed)}.`;
  const bits: string[] = [];
  if (d.shown) bits.push(`shown ${clock(d.shown)}${d.surface ? ` ${SURFACE[d.surface]}` : ''}`);
  else if (d.delivered) bits.push(`reached it ${clock(d.delivered)}, but it did not say it showed`);
  else bits.push('sent, no word back');
  if (d.sound) bits.push(d.sound === 'sound' ? 'with sound' : d.sound === 'vibrate' ? 'vibrating' : 'silently');
  else if (d.shown) bits.push(d.meantToSound ? 'meant to sound (it did not say if it did)' : 'meant to be silent');
  if (d.locked) bits.push('the phone was locked');
  if (d.screenOn === false && !d.locked) bits.push('the screen was off');
  if (d.pageOpen) bits.push('a page of the app was open behind');
  if (d.tapped) bits.push(`tapped ${clock(d.tapped)}`);
  if (d.dismissed) bits.push(`swiped away ${clock(d.dismissed)}`);
  if (d.beside) bits.push(d.beside.length ? `${d.beside.length} other ${d.beside.length === 1 ? 'notification' : 'notifications'} beside it` : 'nothing else of ours beside it');
  return `${name}: ${bits.join(', ')}.`;
}

// ------------------------------------------------------------------ the pictures

/** What a notification said: the hub's words, else the message's own (the words are kept a little while only). */
function words(c: P.CheckinView, s: P.SeenSent): { title: string; lines: { author?: string; body: string }[]; network: P.Network | null } {
  const network = asNet(s.network) ?? asNet(c.context.row.network);
  if (s.lines.length && s.conv) {
    const direct = s.conv.shape === 'direct';
    const n = Math.max(s.count, s.lines.length);
    return { title: direct || n < 2 ? (s.title ?? c.title) : `${s.conv.title} (${n})`, lines: s.lines.map((l) => (direct ? { body: l.body } : { author: l.author, body: l.body })), network };
  }
  return { title: s.title ?? c.title, lines: (s.body ?? c.preview).split('\n').map((body) => ({ body })), network };
}

function DeviceMock({ c, s, d }: { c: P.CheckinView; s: P.SeenSent; d: P.SeenDevice | null }) {
  if (d?.kind === 'page' || d?.surface === 'toast') return <ToastMock c={c} s={s} />;
  if (d && !d.phone) return <DesktopMock c={c} s={s} d={d} />;
  return <AndroidMock c={c} s={s} d={d} />;
}

/** The person's or chat's picture, or its letters on a colour. */
function Pic({ id, name, url, size }: { id: string; name: string; url: string | null; size: number }) {
  return url ? (
    <img class="calib-pic" src={url} alt="" width={size} height={size} loading="lazy" />
  ) : (
    <span class="calib-pic" style={{ width: `${size}px`, height: `${size}px`, background: hueOf(id) }}>
      {initials(name)}
    </span>
  );
}

const netTitle = (n: P.Network) => n[0].toUpperCase() + n.slice(1);

/** An Android notification: in the shade (with what was beside it), on the lock screen, or as a heads-up. */
function AndroidMock({ c, s, d }: { c: P.CheckinView; s: P.SeenSent; d: P.SeenDevice | null }) {
  const w = words(c, s);
  const surface = d?.surface ?? 'shade';
  const at = d?.shown ?? s.at;
  const heard = d?.sound === 'sound' || (!d?.sound && s.sounded);
  return (
    <figure class={`calib-mock android am-${surface}`} data-mock="android" data-surface={surface}>
      <div class="am-screen">
        {surface === 'lock' && (
          <div class="am-lock">
            <span class="am-clock">{clock(at)}</span>
            <Icon name="lock" size={12} />
          </div>
        )}
        {surface === 'heads_up' && <div class="am-app-behind" aria-hidden="true" />}
        {surface !== 'lock' && surface !== 'heads_up' && (
          <div class="am-status" aria-hidden="true">
            {clock(at)}
          </div>
        )}
        <div class="am-card" data-mock-card>
          <div class="am-head">
            <span class="am-app">
              <Icon name="chat" size={11} />
            </span>
            <span>dither-chat</span>
            {w.network && <span>· {netTitle(w.network)}</span>}
            <span>· {clock(at)}</span>
            {heard && <Icon name="bell" size={10} />}
            {d?.sound === 'vibrate' && (
              <span class="am-vib" title="Vibrated">
                ≋
              </span>
            )}
          </div>
          <div class="am-body">
            <div class="am-text">
              <b class="am-title">{w.title}</b>
              {w.lines.slice(-4).map((l) => (
                <span class="am-line">
                  {l.author && <b>{l.author} </b>}
                  {l.body}
                </span>
              ))}
            </div>
            <Pic id={c.conversationId ?? c.messageId} name={w.title} url={s.icon} size={36} />
          </div>
          {c.side !== 'foryou' && (
            <div class="am-actions">
              <span>Reply</span>
              <span>{s.sounded ? 'Could have waited' : 'Louder'}</span>
            </div>
          )}
        </div>
        {surface !== 'heads_up' &&
          (d?.beside ?? []).slice(0, 4).map((b) => (
            <div class="am-card am-other">
              <div class="am-head">
                <span class="am-app">
                  <Icon name="chat" size={11} />
                </span>
                <span>dither-chat · {clock(b.at)}</span>
              </div>
              <div class="am-text">
                <b class="am-title">{b.title}</b>
                <span class="am-line">{b.body.split('\n').at(-1)}</span>
              </div>
            </div>
          ))}
      </div>
      <figcaption>
        {d?.label ?? 'Phone'}
        {d?.surface ? `, ${SURFACE[d.surface]}` : ', where on the phone is not known'}
        {!d || d.beside === null ? '; what else showed is not known' : ''}
      </figcaption>
    </figure>
  );
}

/** A browser's notification on a computer: the system's card in a corner of the screen. */
function DesktopMock({ c, s, d }: { c: P.CheckinView; s: P.SeenSent; d: P.SeenDevice }) {
  const w = words(c, s);
  return (
    <figure class="calib-mock desktop" data-mock="desktop">
      <div class="dm-screen">
        <div class="dm-card" data-mock-card>
          <Pic id={c.conversationId ?? c.messageId} name={w.title} url={s.icon} size={40} />
          <div class="dm-text">
            <b>{w.title}</b>
            {w.lines.slice(-3).map((l) => (
              <span>
                {l.author ? `${l.author}: ` : ''}
                {l.body}
              </span>
            ))}
            <small>dither-chat · {clock(d.shown ?? s.at)}</small>
          </div>
        </div>
        {(d.beside ?? []).slice(0, 2).map((b) => (
          <div class="dm-card dm-other">
            <div class="dm-text">
              <b>{b.title}</b>
              <span>{b.body.split('\n').at(-1)}</span>
            </div>
          </div>
        ))}
      </div>
      <figcaption>
        {d.label}, {d.sound === 'sound' ? 'with sound' : d.sound === 'silent' ? 'silently' : s.sounded ? 'meant to sound' : 'silently'}
      </figcaption>
    </figure>
  );
}

/** The notification the open app drew itself, at the top of its window. */
function ToastMock({ c, s }: { c: P.CheckinView; s: P.SeenSent }) {
  const w = words(c, s);
  return (
    <figure class="calib-mock toastm" data-mock="toast">
      <div class="tm-card" data-mock-card>
        <Pic id={c.conversationId ?? c.messageId} name={w.title} url={s.icon} size={28} />
        <div>
          <b>{w.title}</b>
          <span>{w.lines.at(-1)?.body}</span>
        </div>
      </div>
      <figcaption>In the open app</figcaption>
    </figure>
  );
}

/** Its row in the inbox (or its card on For you), drawn from the message: where a quiet one waited. */
function InAppMock({ c }: { c: P.CheckinView }) {
  const r = c.context.row;
  const net = asNet(r.network);
  const where = c.context.forYou ? 'For you' : c.context.opened ? `Opened from ${SOURCE[c.context.opened.source] ?? 'the app'}` : 'The inbox';
  return (
    <figure class="calib-mock inapp" data-mock="row">
      <div class="im-row" data-mock-card>
        <span class="im-av">
          <Pic id={c.conversationId ?? c.messageId} name={r.title} url={null} size={34} />
          {net && <NetBadge network={net} size={14} class="im-net" />}
        </span>
        <span class="im-main">
          <span class="im-top">
            <b>{r.title}</b>
            <span>{clock(r.at)}</span>
          </span>
          <span class="im-preview">{r.preview}</span>
        </span>
        <span class="im-dot" aria-hidden="true" />
      </div>
      <figcaption>{where}: its row, drawn from the message</figcaption>
    </figure>
  );
}
