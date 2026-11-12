/**
 * New group, as pages of the palette (docs/group-settings.md "Making a group", docs/palette.md): pick people once from
 * everyone any of your accounts could put in a group; then where (which account holds that set), when more than one
 * could or not everyone fits; then a name, and make it. A group lives on one network: the pages find which. The rules
 * that need no browser are groups.ts.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { convTitle, identityName } from '../model.ts';
import { fitLine, groupCap, labelAccounts, leftOutLine, madeToast, makeLabel, makeProblem, mergePeople, namePlaceholder, networksOf, preselect, whereOptions, type GroupPerson, type MakerAccount } from '../groups.ts';
import { matches, paletteHeld, paletteStack, type Entry } from '../palette.ts';
import { api, applyEvents, db, go, rev, toast } from '../state.ts';
import { AccountChip, Avatar, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import { multiOf, PickChips, PickFooter, pickRows, usePicked, type Pickable } from './MultiPick.tsx';
import { backPage, pushPage, releasePalette, setEntry } from './Palette.tsx';
import { Frame, type Row } from './PaletteFrame.tsx';
import { homeRoute } from './Sidebar.tsx';

interface Loaded {
  view: P.GroupCandidatesView;
  accounts: MakerAccount[];
  people: GroupPerson[];
}

/** What New group asked the hub, by the people page's entry: the where and name pages above it read the same. */
const loaded = signal<Record<number, Loaded | { error: string }>>({});

const netName = (n: P.Network) => NETWORK_META[n]?.name ?? n;

function personName(identityId: string): string {
  const i = db.identities.get(identityId);
  const p = i?.personId ? db.persons.get(i.personId) : null;
  return p?.name ?? identityName(identityId);
}

function load(id: number) {
  api<P.GroupCandidatesView>('/api/groups/candidates')
    .then((view) => {
      for (const i of view.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
      const accounts = labelAccounts(view, (a) => db.accounts.get(a)?.label ?? a);
      const people = mergePeople(accounts, (identityId) => {
        const i = db.identities.get(identityId);
        if (!i) return undefined;
        const p = i.personId ? db.persons.get(i.personId) : null;
        return { personId: p ? p.id : null, name: p?.name ?? identityName(identityId), handle: i.handle };
      });
      loaded.value = { ...loaded.value, [id]: { view, accounts, people } };
    })
    .catch((err: Error) => (loaded.value = { ...loaded.value, [id]: { error: err.message } }));
}

const entryOf = (id: number) => paletteStack.value?.find((x) => x.id === id);
const pickedOf = (data: Loaded, id: number) => (entryOf(id)?.picked ?? []).map((k) => data.people.find((p) => p.key === k)).filter((p): p is GroupPerson => !!p);

/** The `unable` reasons, once each (WhatsApp's line). */
const unableLines = (v: P.GroupCandidatesView) => [...new Set(v.unable.map((u) => u.reason))];

/** Where the picked go next: straight to the name when one account qualifies and reaches everyone, else where. */
function goOn(data: Loaded, from: number) {
  const picked = pickedOf(data, from);
  if (!picked.length) return;
  const { options } = whereOptions(data.accounts, picked);
  const only = options.length === 1 && !options[0].left.length ? options[0] : null;
  if (only) return pushName(from, only.account, only.people);
  pushPage({ kind: 'group-where', from });
}

function pushName(from: number, a: MakerAccount, people: GroupPerson[]) {
  const identities = people.map((p) => p.via.find((v) => v.accountId === a.accountId)!.identityId);
  pushPage({ kind: 'group-name', from, accountId: a.accountId, identities }, entryOf(from)?.draft ?? '');
}

/** The networks someone can be put in a group on: a badge each, the accounts in the tooltip where you have several. */
function Nets({ p, accounts }: { p: GroupPerson; accounts: MakerAccount[] }) {
  return (
    <span class="group-nets">
      {networksOf(p).map((n) => {
        const via = p.via.filter((v) => v.network === n).map((v) => accounts.find((a) => a.accountId === v.accountId)!.label);
        return (
          <span class="group-net" data-network={n} title={via.join(', ')}>
            <NetBadge network={n} size={14} />
          </span>
        );
      })}
    </span>
  );
}

/** New group: everyone any account could put in a group, one row per person; pick, and Next. */
export function GroupPage({ e }: { e: Entry & { kind: 'group' } }) {
  rev.value;
  const data = loaded.value[e.id];
  useEffect(() => {
    if (!data) load(e.id);
  }, []);
  const ok = data && 'view' in data ? data : null;
  const cap = ok ? groupCap(ok.accounts) : 10;
  const pick = usePicked(e, cap);
  // Opened with people (a DM's "New group with …"): those of them that are someone here, once.
  useEffect(() => {
    if (ok && e.picked === undefined) setEntry(e.id, { picked: preselect(e.with, ok.people, cap) });
  }, [!!ok]);

  if (!data) return <Frame e={e} class="new-group" placeholder="Search people" before={<Loading inline label="Loading…" />} />;
  if ('error' in data)
    return (
      <Frame
        e={e}
        class="new-group"
        body={
          <p class="add-mem-error" role="alert">
            <Icon name="alert" size={13} /> {data.error}
          </p>
        }
      />
    );
  const { view, accounts, people } = data;
  if (!accounts.length)
    return (
      <Frame
        e={e}
        class="new-group"
        body={
          <div class="group-none">
            <p class="set-help">None of your connected accounts can make a group from here.</p>
            {unableLines(view).map((l) => (
              <p class="set-help group-unable">{l}</p>
            ))}
          </div>
        }
      />
    );

  const needle = e.q.trim();
  const picked = pickedOf(data, e.id);
  const shown = (needle ? people.filter((p) => matches(`${p.name} ${p.handles}`, needle)) : people).slice(0, 150);
  const items: Pickable[] = shown.map((p) => {
    const i = db.identities.get(p.via[0].identityId);
    const person = i?.personId ? db.persons.get(i.personId) : null;
    return {
      key: p.key,
      name: p.name,
      avatarId: p.key,
      avatar: person?.avatar ?? i?.avatar,
      sub: [networksOf(p).map(netName).join(' · '), p.last ? `talked ${ago(p.last)}` : null].filter(Boolean).join(' · '),
      extra: <Nets p={p} accounts={accounts} />,
    };
  });
  const unable = view.unable.length ? unableLines(view).map((l, i): Row => ({ key: `unable-${i}`, class: 'set-help group-unable', label: l })) : [];
  const fit = fitLine(accounts, picked);
  const n = pick.picked.length;
  return (
    <Frame
      e={e}
      class="new-group"
      placeholder="Search people"
      rows={[...pickRows(items, pick.picked, cap, pick.toggle), ...(items.length ? unable : [])]}
      empty={<div class="fwd-empty">{needle ? `Nobody matches “${needle}”.` : 'Nobody your accounts could put in a group yet.'}</div>}
      listClass="fwd-list"
      listLabel="People"
      multi={multiOf(pick, () => goOn(data, e.id))}
      before={
        (fit || n > 0) && (
          <>
            {fit && <p class="fwd-sub group-fit">{fit}</p>}
            <PickChips picked={pick.picked} nameOf={(k) => people.find((p) => p.key === k)?.name ?? k} onRemove={pick.toggle} />
          </>
        )
      }
      after={<PickFooter class="group-next" n={n} max={cap} busy={false} icon="chevronRight" track="next" label="Next" onGo={() => goOn(data, e.id)} />}
    />
  );
}

/** Where: the accounts that could hold some of the picked, best first, and why the others cannot. */
export function WherePage({ e }: { e: Entry & { kind: 'group-where' } }) {
  rev.value;
  const data = loaded.value[e.from];
  if (!data || 'error' in data) return <Frame e={e} class="new-group" body={<Loading inline label="Loading…" />} />;
  const picked = pickedOf(data, e.from);
  const { options, short } = whereOptions(data.accounts, picked);
  const lines = [...short, ...unableLines(data.view)];
  const rows = options.map(
    (o): Row => ({
      key: o.account.accountId,
      class: 'switcher-row group-where-row',
      data: { network: o.account.network, all: o.left.length ? 'no' : 'yes' },
      track: 'row (where)',
      icon: <NetBadge network={o.account.network} size={20} />,
      label: o.account.label,
      sub: o.sub,
      run: () => pushName(e.from, o.account, o.people),
    }),
  );
  const notes = lines.map((l, i): Row => ({ key: `why-${i}`, class: 'set-help group-why', label: l }));
  if (!rows.length)
    return (
      <Frame
        e={e}
        title="Where to make it"
        class="new-group"
        body={
          <div class="group-none">
            <p class="set-help">None of your accounts can make a group of these people:</p>
            {lines.map((l) => (
              <p class="set-help group-why">{l}</p>
            ))}
            <div class="btn-row">
              <button class="btn ghost small" onClick={backPage}>
                Back
              </button>
            </div>
          </div>
        }
      />
    );
  return <Frame e={e} title="Where to make it" class="new-group" rows={[...rows, ...notes]} listLabel="Where" />;
}

/** Name it and make it. While it is asked nothing leaves the page: a group half made must not look cancelled. */
export function NamePage({ e }: { e: Entry & { kind: 'group-name' } }) {
  rev.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loaded.value[e.from];
  // The name, kept on the people page too, so backing out and coming back finds it.
  useEffect(() => {
    if (entryOf(e.from) && entryOf(e.from)!.draft !== e.q) setEntry(e.from, { draft: e.q });
  }, [e.q]);
  useEffect(() => () => void (paletteHeld.value = false), []);
  if (!data || 'error' in data) return <Frame e={e} class="new-group" body={<Loading inline label="Loading…" />} />;
  const account = data.accounts.find((a) => a.accountId === e.accountId);
  if (!account) return <Frame e={e} class="new-group" body={<p class="set-help">That account cannot make a group now.</p>} />;
  const rule = account.rule;
  const picked = pickedOf(data, e.from);
  const people = picked.filter((p) => p.via.some((v) => v.accountId === account.accountId));
  const left = picked.filter((p) => !people.includes(p));
  const acc = db.accounts.get(account.accountId);
  const problem = makeProblem(account.network, e.q, e.identities.length);
  const label = makeLabel(rule);

  const make = async () => {
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    paletteHeld.value = true;
    const name = e.q.trim();
    try {
      const r = await api<P.CreateGroupView>('/api/groups', { body: { accountId: account.accountId, ...(name ? { name } : {}), identities: e.identities } });
      applyEvents([{ t: 'conversation', conversation: r.conversation }]);
      releasePalette();
      go(homeRoute(r.conversation));
      const t = madeToast(name || convTitle(r.conversation), r, personName);
      toast({ kind: 'info', ...t }, 8000);
    } catch (err) {
      paletteHeld.value = false;
      setBusy(false);
      setError((err as Error).message);
    }
  };

  const leftLine = leftOutLine(account, left);
  return (
    <Frame
      e={e}
      title={`New ${rule.noun} on ${account.label}`}
      class="new-group group-name"
      placeholder={namePlaceholder(rule)}
      typing
      onEnter={() => void make()}
      body={
        <div class="group-summary">
          <div class="group-as">{acc && <AccountChip account={acc} small />}</div>
          <div class="group-people">
            {people.map((p) => {
              const i = db.identities.get(p.via[0].identityId);
              const person = i?.personId ? db.persons.get(i.personId) : null;
              return (
                <span class="group-person" data-key={p.key}>
                  <Avatar id={p.key} name={p.name} url={person?.avatar ?? i?.avatar} size={22} />
                  <span class="group-person-name">{p.name}</span>
                </span>
              );
            })}
          </div>
          {leftLine && <p class="set-help group-left">{leftLine}</p>}
          {rule.mode === 'invite' && <p class="set-help group-invite">They get an invite and are in once they accept.</p>}
          {error && (
            <p class="add-mem-error group-error" role="alert">
              <Icon name="alert" size={13} /> {error}
            </p>
          )}
          <div class="btn-row group-make-row">
            <button class="btn primary group-make" data-track="make group" disabled={!!problem || busy} onClick={() => void make()}>
              <Icon name="groups" size={14} /> {busy ? 'Making…' : label}
            </button>
            {problem && !busy && <span class="set-help group-problem">{problem}</span>}
          </div>
        </div>
      }
    />
  );
}
