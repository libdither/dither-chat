/** Every community and group in one place, full screen, in whatever order suits the moment. */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { activityOfSpace, allCommunities, categoriesOf, convsUnder, convTitle, folderConvs, kindLabel, memberOf, netName, placePref, railEntries, spaceUnread, sumUnread, unreadOf, visibleConv, type RailEntry } from '../model.ts';
import { api, db, go, prefs, rev, setPrefs, toast, type DirectorySort } from '../state.ts';
import { AccountChip, Avatar, Count, Empty, Modal, NetBadge } from './bits.tsx';
import { dragProps, dropClass } from './dnd.tsx';
import { Icon } from './icons.tsx';
import { dropPlace, openPlaceMenu } from './Organize.tsx';
import { saveThreshold, thresholdOf } from './Reorganize.tsx';
import { pct, Sensitivity } from './Sensitivity.tsx';

export interface Place {
  key: string;
  kind: 'space' | 'conversation' | 'folder';
  id: string;
  name: string;
  topic: string | null;
  icon: string | null;
  network: P.Network | null;
  noun: string;
  accountIds: string[];
  convs: P.ConversationView[];
  badge: number;
  unread: number;
  last: number;
}

const fromSpace = (s: P.SpaceView): Place => {
  const u = spaceUnread(s.id);
  return { key: `space:${s.id}`, kind: 'space', id: s.id, name: s.name, topic: s.topic, icon: s.icon, network: s.network, noun: NETWORK_META[s.network].spaceNoun, accountIds: s.accountIds, convs: convsUnder(s.id), badge: u.badge, unread: u.unread, last: activityOfSpace(s.id) };
};
const fromConv = (c: P.ConversationView): Place => {
  const u = unreadOf(c);
  return { key: `conversation:${c.id}`, kind: 'conversation', id: c.id, name: convTitle(c), topic: c.topic, icon: c.avatar, network: c.network, noun: kindLabel(c).replace(/^\w+ /, ''), accountIds: c.vantages.map((v) => v.accountId), convs: [c], badge: u.badge, unread: u.unread, last: c.lastMessageAt ?? 0 };
};
const fromEntry = (e: RailEntry): Place => {
  if (e.kind === 'space') return fromSpace(e.space);
  if (e.kind === 'conversation') return fromConv(e.conv);
  const convs = folderConvs(e.folder);
  const u = sumUnread(convs);
  return { key: e.key, kind: 'folder', id: e.folder.id, name: e.folder.name, topic: null, icon: null, network: null, noun: `folder, ${e.folder.items.length} items`, accountIds: [], convs, badge: u.badge, unread: u.unread, last: Math.max(0, ...convs.map((c) => c.lastMessageAt ?? 0)) };
};

export function allPlaces(): Place[] {
  const convs = [...db.conversations.values()].filter((c) => visibleConv(c) && (c.shape === 'group' || (c.shape === 'channel' && !c.spaceIds.length)));
  return [...allCommunities().map(fromSpace), ...convs.map(fromConv)];
}

const SORTS: { id: DirectorySort; label: string }[] = [
  { id: 'recency', label: 'Recent' },
  { id: 'activity', label: 'Active' },
  { id: 'unread', label: 'Unread' },
  { id: 'name', label: 'Name' },
  { id: 'network', label: 'Network' },
  { id: 'manual', label: 'Your order' },
  { id: 'category', label: 'Category' },
];

function open(p: Place) {
  if (p.kind === 'folder') go({ view: 'folder', folder: p.id });
  else if (p.kind === 'space') go({ view: 'space', space: p.id });
  else go({ view: 'inbox', conv: p.id });
}

function Card({ place: p, week, drag, onCategories }: { place: Place; week: number; drag: boolean; onCategories: (p: Place) => void }) {
  const pref = placePref(p.kind, p.id);
  const cats = p.kind === 'folder' ? [] : categoriesOf(p.kind, p.id);
  const props = dragProps({ key: p.key, label: p.name, group: 'directory', axis: 'x', onDrop: drag ? dropPlace : undefined, onMenu: (x, y) => openPlaceMenu(p.key, p.name, x, y) });
  const accounts = p.accountIds.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  return (
    <article class={`dir-card ${pref.hidden ? 'hidden-place' : ''} ${dropClass(p.key)}`} {...props}>
      <button class="dir-card-main" onClick={() => open(p)}>
        <span class="dir-card-icon">
          {p.kind === 'folder' ? (
            <span class="folder-row-icon"><Icon name="folder" /></span>
          ) : (
            <Avatar id={p.id} name={p.name} url={p.icon} size={48} square />
          )}
        </span>
        <span class="dir-card-text">
          <span class="dir-card-name">
            {p.name}
            {pref.pinned && <Icon name="star" size={12} class="row-star" />}
          </span>
          <span class="dir-source">
            {p.network ? (
              <>
                <NetBadge network={p.network} size={15} /> {netName(p.network)} {p.noun}
              </>
            ) : (
              <>Across networks · {p.noun}</>
            )}
          </span>
          {p.topic && <span class="dir-topic">{p.topic}</span>}
        </span>
        <Count n={p.badge} />
      </button>
      {accounts.length > 0 && (
        <div class="dir-accounts">
          {accounts.map((a) => (
            <AccountChip account={a} small />
          ))}
        </div>
      )}
      <div class="dir-foot">
        <span class="dir-stats">
          {p.last ? `Last message ${ago(p.last)}` : 'No messages stored'}
          {p.kind === 'space' && ` · ${p.convs.length} channels`}
          {week > 0 && ` · ${week} this week`}
        </span>
        <span class="dir-actions">
          {p.kind !== 'folder' && (
            <button class="icon-btn small" title="Categories" aria-label={`Categories for ${p.name}`} onClick={() => onCategories(p)}>
              <Icon name="layers" size={14} />
            </button>
          )}
          <button class="icon-btn small" title="Arrange" aria-label={`Arrange ${p.name}`} onClick={(e) => openPlaceMenu(p.key, p.name, (e as MouseEvent).clientX, (e as MouseEvent).clientY)}>
            <Icon name="settings" size={14} />
          </button>
        </span>
      </div>
      {cats.length > 0 && (
        <div class="dir-cats">
          {cats.map((c) => (
            <span class="cat-chip" style={{ '--cat': c.color ?? '#8b93a7' } as any}>
              {c.name}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function PlaceCategories({ place: p, onClose }: { place: Place; onClose: () => void }) {
  rev.value;
  const kind = p.kind as 'space' | 'conversation';
  const rows = db.placeCategories.get(`${kind}:${p.id}`) ?? [];
  const set = (categoryId: string, assigned: boolean | null) => api('/api/category-overrides', { method: 'PUT', body: { categoryId, kind, id: p.id, assigned } });
  return (
    <Modal title={`Categories: ${p.name}`} onClose={onClose}>
      <p class="set-help">Your choice always beats the model. The score comes from this place's name, topic and channel names, never its messages.</p>
      {db.categories.map((c) => {
        const r = rows.find((x) => x.categoryId === c.id);
        const yes = r ? memberOf(r) : false;
        return (
          <div class="cat-row">
            <span class="cat-row-text">
              <b>{c.name}</b>
              <small>
                {r?.p != null ? `${pct(r.p)} by ${r.provider}, ${pct(thresholdOf(c))} needed` : 'Not scored yet'}
                {r?.override != null && ' · your choice'}
              </small>
            </span>
            <span class="level-picker">
              <button class={`chip-btn ${r?.override === true ? 'on' : ''}`} onClick={() => set(c.id, true)}>Yes</button>
              <button class={`chip-btn ${r?.override === false ? 'on' : ''}`} onClick={() => set(c.id, false)}>No</button>
              <button class={`chip-btn ${r?.override == null ? 'on' : ''}`} onClick={() => set(c.id, null)}>Auto{r?.override == null && yes ? ' (yes)' : ''}</button>
            </span>
          </div>
        );
      })}
    </Modal>
  );
}

function ManageCategories({ onClose }: { onClose: () => void }) {
  rev.value;
  const [name, setName] = useState('');
  const [at, setAt] = useState<Record<string, number>>({});
  const matching = (c: P.CategoryView) => [...db.placeCategories.values()].filter((rows) => rows.some((x) => x.categoryId === c.id && memberOf(x, at))).length;
  const save = (c: P.CategoryView, patch: Partial<P.CategoryView>) => api(`/api/categories/${c.id}`, { method: 'PATCH', body: patch }).catch((e) => toast({ kind: 'error', title: 'Could not save', body: e.message }));
  const val = (e: Event) => (e.target as HTMLInputElement).value;
  return (
    <Modal title="Categories" onClose={onClose} wide>
      <p class="set-help">
        Each category is a yes/no question asked of every place. Now answering: <b>{db.categoryProvider === 'keyword' ? 'keyword matching, no model' : db.categoryProvider === 'jev' ? 'jev, the local reranker' : db.categoryProvider}</b>. The
        model is never fully sure, so each category has a sensitivity: slide toward More to take in places it is less sure of. Only names, topics and channel
        names are used, and they stay on your hub.
      </p>
      {db.categories.map((c) => (
        <div class="cat-edit">
          <input class="input" aria-label="Name" value={c.name} onChange={(e) => save(c, { name: val(e) })} />
          <input class="input" aria-label="Question" value={c.question} onChange={(e) => save(c, { question: val(e) })} />
          <input class="input" aria-label="Keywords" placeholder="Keywords, comma separated" value={c.keywords.join(', ')} onChange={(e) => save(c, { keywords: val(e).split(',').map((k) => k.trim()).filter(Boolean) })} />
          <button class="icon-btn small" title="Delete category" onClick={() => confirm(`Delete “${c.name}”?`) && api(`/api/categories/${c.id}`, { method: 'DELETE' })}>
            <Icon name="trash" size={14} />
          </button>
          <Sensitivity threshold={thresholdOf(c, at)} count={`${matching(c)} places`} onInput={(t) => setAt({ ...at, [c.id]: t })} onChange={(t) => void saveThreshold(c, t)} />
        </div>
      ))}
      <form
        class="keyword-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) api('/api/categories', { body: { name: name.trim() } }).then(() => setName(''));
        }}
      >
        <input class="input" placeholder="New category" value={name} onInput={(e) => setName(val(e))} />
        <button class="btn ghost small" type="submit"><Icon name="plus" size={13} /> Add</button>
        <button class="btn ghost small" type="button" onClick={() => api('/api/categories/rescore', { body: {} })}><Icon name="refresh" size={13} /> Score everything again</button>
      </form>
    </Modal>
  );
}

export function DirectoryPane({ onBack }: { onBack: () => void }) {
  rev.value;
  const sort = prefs.value.directorySort;
  const [q, setQ] = useState('');
  const [net, setNet] = useState<P.Network | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [stats, setStats] = useState<P.PlaceStats>({ week: {}, mine: {} });
  const [editing, setEditing] = useState<Place | null>(null);
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    api<P.PlaceStats>('/api/directory/stats').then(setStats).catch(() => {});
  }, []);
  const week = (p: Place) => p.convs.reduce((n, c) => n + (stats.week[c.id] ?? 0), 0);

  const manual = sort === 'manual';
  const base = manual ? railEntries(showHidden ? 'hidden' : 'shown').map(fromEntry) : allPlaces();
  const needle = q.trim().toLowerCase();
  const shown = base.filter((p) => {
    if (!showHidden && !manual && placePref(p.kind, p.id).hidden) return false;
    if (net && p.network !== net) return false;
    return !needle || p.name.toLowerCase().includes(needle) || p.topic?.toLowerCase().includes(needle) || (p.kind !== 'folder' && categoriesOf(p.kind, p.id).some((c) => c.name.toLowerCase().includes(needle)));
  });
  const byName = (a: Place, b: Place) => a.name.localeCompare(b.name);
  const sorted = useMemo(() => {
    const xs = [...shown];
    if (sort === 'recency') xs.sort((a, b) => b.last - a.last);
    if (sort === 'activity') xs.sort((a, b) => week(b) - week(a) || b.last - a.last);
    if (sort === 'unread') xs.sort((a, b) => b.badge - a.badge || b.unread - a.unread || b.last - a.last);
    if (sort === 'name' || sort === 'network' || sort === 'category') xs.sort(byName);
    return xs;
  }, [rev.value, sort, q, net, showHidden, stats]);

  let sections: { title: string | null; color?: string | null; places: Place[]; network?: P.Network }[];
  if (sort === 'network') {
    sections = NETWORKS.map((n) => ({ title: netName(n), network: n, places: sorted.filter((p) => p.network === n) })).filter((s) => s.places.length);
  } else if (sort === 'category') {
    const places = sorted.filter((p) => p.kind !== 'folder') as (Place & { kind: 'space' | 'conversation' })[];
    sections = db.categories.map((c) => ({ title: c.name, color: c.color, places: places.filter((p) => categoriesOf(p.kind, p.id).some((x) => x.id === c.id)) })).filter((s) => s.places.length);
    const none = places.filter((p) => !categoriesOf(p.kind, p.id).length);
    if (none.length) sections.push({ title: 'Uncategorised', places: none });
  } else sections = [{ title: null, places: sorted }];

  return (
    <section class="pane directory">
      <header class="board-head dir-head">
        <button class="icon-btn dir-back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <div>
          <h2>All communities and groups</h2>
          <p>{shown.length} {shown.length === 1 ? 'place' : 'places'} across your accounts</p>
        </div>
      </header>
      <div class="dir-controls">
        <div class="search dir-search">
          <Icon name="search" size={15} />
          <input placeholder="Filter by name, topic or category" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <div class="level-picker" role="group" aria-label="Order">
          {SORTS.map((s) => (
            <button class={`chip-btn ${sort === s.id ? 'on' : ''}`} onClick={() => setPrefs({ directorySort: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        <div class="level-picker" role="group" aria-label="Network">
          {NETWORKS.map((n) => (
            <button class={`chip-btn ${net === n ? 'on' : ''}`} onClick={() => setNet(net === n ? null : n)}>
              <NetBadge network={n} size={14} /> {netName(n)}
            </button>
          ))}
          <button class={`chip-btn ${showHidden ? 'on' : ''}`} onClick={() => setShowHidden(!showHidden)}>
            <Icon name="eye" size={13} /> Hidden
          </button>
          <button class="chip-btn" onClick={() => setManaging(true)}>
            <Icon name="layers" size={13} /> Edit categories
          </button>
        </div>
      </div>
      <div class="dir-scroll">
        {manual && <p class="set-help dir-note">Your sidebar, in order. Drag to rearrange, or hold on a phone. Add a group to it from its arrange menu.</p>}
        {!shown.length && (base.length ? <Empty icon="grid" title="Nothing matches" /> : <Empty icon="grid" title="Nothing here yet">Servers, spaces and groups show up once an account has synced them.</Empty>)}
        {sections.map((s) => (
          <section>
            {s.title && (
              <h3 class="dir-section" style={{ '--cat': s.color ?? 'transparent' } as any}>
                {s.network && <NetBadge network={s.network} size={16} />} {s.title} <small>{s.places.length}</small>
              </h3>
            )}
            <div class="dir-grid">
              {s.places.map((p) => (
                <Card place={p} week={week(p)} drag={manual && !showHidden} onCategories={setEditing} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {editing && <PlaceCategories place={editing} onClose={() => setEditing(null)} />}
      {managing && <ManageCategories onClose={() => setManaging(false)} />}
    </section>
  );
}
