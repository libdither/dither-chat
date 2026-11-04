/**
 * History on a profile page (docs/history.md): what changed about a place (name, description, picture, settings,
 * who joined and left) or a person (names, pictures, bio, status, pronouns on each network), newest first.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_KEYS, ABOUT_LABEL } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { loadChanges, retention } from '../history.ts';
import { identityName, netName } from '../model.ts';
import { db, openProfile, rev } from '../state.ts';
import { valueText } from './About.tsx';
import { Avatar, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Card } from './ProfileShell.tsx';

const FIELD: Record<string, string> = {
  name: 'Name',
  topic: 'Description',
  avatar: 'Picture',
  banner: 'Banner',
  displayName: 'Display name',
  handle: 'Username',
  bio: 'Bio',
  status: 'Status',
  pronouns: 'Pronouns',
};
const LONG = new Set(['topic', 'bio']);
const PICTURE = new Set(['avatar', 'banner']);

/** A setting's value in words. Older entries kept it as text ("604800", "true"). */
function settingValue(key: P.AboutKey, v: unknown): string {
  if (v === null || v === undefined) return 'nothing';
  const parsed: unknown = typeof v !== 'string' ? v : v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
  return valueText(key, parsed);
}

/** A status, as `{ text, emoji }` (older entries: text). */
function statusText(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  const s = v as { text?: string; emoji?: string };
  return [s.emoji, s.text].filter(Boolean).join(' ') || null;
}

const asText = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Who, as a name you can click. */
function Who({ id }: { id: string }) {
  const i = db.identities.get(id);
  const p = i?.personId ? db.persons.get(i.personId) : null;
  return (
    <button class="hist-who" onClick={() => openProfile(id)}>
      <Avatar id={p?.id ?? id} name={p?.name ?? identityName(id)} url={p?.avatar ?? i?.avatar} size={18} />
      {p?.name ?? identityName(id)}
    </button>
  );
}

const SHOWN = 8;

export function HistoryCard({ path, network }: { path: string; network?: P.Network }) {
  rev.value;
  const [changes, setChanges] = useState<P.ChangeView[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    loadChanges(path).then((c) => live && setChanges(c), () => live && setChanges([]));
    return () => void (live = false);
  }, [path]);
  if (!changes) return null;
  if (!changes.length && !retention.value.changes) return null;
  const shown = all ? changes : changes.slice(0, SHOWN);
  return (
    <Card title="History" icon="clock" count={changes.length || undefined}>
      {!changes.length && <p class="pf-empty">No changes seen yet. Renames, new descriptions and pictures, settings and members show here as they happen.</p>}
      <ol class="hist-list">{shown.map((c) => <Change c={c} network={network} />)}</ol>
      {!all && changes.length > SHOWN && (
        <button class="btn ghost small" onClick={() => setAll(true)}>
          Show all {changes.length}
        </button>
      )}
    </Card>
  );
}

function Change({ c, network }: { c: P.ChangeView; network?: P.Network }) {
  const [open, setOpen] = useState(false);
  const ident = c.target.kind === 'identity' ? db.identities.get(c.target.id) : null;
  const where = ident && !network ? (
    <span class="hist-src" title={netName(ident.network)}>
      <NetGlyph network={ident.network} size={11} />
    </span>
  ) : null;
  const when = (
    <time class="hist-when" title={fullTime(c.at)}>
      {ago(c.at)}
    </time>
  );

  const by = c.actorId ? (
    <>
      <span>by</span>
      <Who id={c.actorId} />
    </>
  ) : null;

  if (c.field === 'member') {
    const joined = c.new !== null;
    return (
      <li class="hist-item">
        <Icon name={joined ? 'plus' : 'x'} size={12} />
        <Who id={c.identityId!} />
        <span>{joined ? 'joined' : 'left'}</span>
        {when}
      </li>
    );
  }

  if (c.field === 'role') {
    const r = (c.new ?? c.old) as { role: string; color?: string };
    const given = c.new !== null;
    return (
      <li class="hist-item">
        <Icon name={given ? 'plus' : 'x'} size={12} />
        <Who id={c.identityId!} />
        <span>{given ? 'was given' : 'lost'}</span>
        <span class="pf-role" style={r.color ? { '--role': r.color } : undefined}>
          {r.role}
        </span>
        {by}
        {when}
      </li>
    );
  }

  if (c.field === 'status')
    return (
      <li class="hist-item">
        <Icon name="smile" size={12} />
        {where}
        <span>
          Status: {statusText(c.old) && <s>{statusText(c.old)}</s>} {statusText(c.old) && '→'} <b>{statusText(c.new) ?? 'cleared'}</b>
        </span>
        {when}
      </li>
    );

  if (PICTURE.has(c.field))
    return (
      <li class="hist-item">
        <Icon name="image" size={12} />
        {where}
        <span>{FIELD[c.field]} changed</span>
        <span class="hist-pics">
          {typeof c.old === 'string' && <img src={c.old} alt="Before" loading="lazy" />}
          <Icon name="chevronRight" size={11} />
          {typeof c.new === 'string' && <img src={c.new} alt="After" loading="lazy" />}
        </span>
        {when}
      </li>
    );

  const setting = (ABOUT_KEYS as readonly string[]).includes(c.field) && !FIELD[c.field];
  const label = setting ? ABOUT_LABEL[c.field as P.AboutKey] : (FIELD[c.field] ?? c.field);
  const show = (v: unknown) => (setting ? settingValue(c.field as P.AboutKey, v) : asText(v));
  if (LONG.has(c.field))
    return (
      <li class="hist-item long">
        <button class="hist-line" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="pencil" size={12} />
          {where}
          <span>{!c.old ? `${label} added` : !c.new ? `${label} removed` : `${label} changed`}</span>
          <span class="hist-more">{open ? 'Hide' : 'Show'}</span>
          {when}
        </button>
        {open && (
          <div class="hist-diff">
            {asText(c.old) && <p class="was">{asText(c.old)}</p>}
            {asText(c.new) && <p class="now">{asText(c.new)}</p>}
          </div>
        )}
      </li>
    );
  return (
    <li class="hist-item">
      <Icon name={setting ? 'settings' : 'pencil'} size={12} />
      {where}
      <span>
        {label}: {c.old !== null && <s>{show(c.old)}</s>} {c.old !== null && '→'} <b>{show(c.new) ?? 'cleared'}</b>
      </span>
      {by}
      {when}
    </li>
  );
}
