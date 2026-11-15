/**
 * The suggested layout in the Organize view (docs/organize.md): what the planner would do, as a tree you tick, and one
 * button to take it. Nothing you arranged moves; servers no rule places get "Move to" chips in the list below instead.
 */
import type { FolderPlan, PlanStep } from '@dither-chat/protocol/folderplan';
import { useState } from 'preact/hooks';
import { takePlan } from '../folderplan.ts';
import { db } from '../state.ts';
import { Icon } from './icons.tsx';

const WHY_ICON: Record<PlanStep['rule'], string> = { network: 'layers', word: 'hash' };

export function SuggestedLayout({ plan }: { plan: FolderPlan }) {
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [personas, setPersonas] = useState(true);
  const [open, setOpen] = useState(true);
  const split = plan.personas.length >= 2;
  // Accounts that have their folder already: new folders go inside them, with nothing to ask.
  const have = split && plan.personas.every((p) => db.folders.some((f) => f.name.trim().toLowerCase() === p.label.trim().toLowerCase() && f.items.some((i) => i.kind === 'folder')));
  if (!plan.steps.length && (!split || have)) return null;
  const chosen = plan.steps.filter((s) => !off.has(s.id));
  const servers = chosen.reduce((n, s) => n + s.spaces.length, 0);
  const made = chosen.filter((s) => !s.into).length + (split && personas && !have ? plan.personas.length : 0);
  const flip = (id: string) => {
    const next = new Set(off);
    next.has(id) ? next.delete(id) : next.add(id);
    setOff(next);
  };
  const groups: { id: string | null; label: string | null; steps: PlanStep[] }[] = split && personas ? [...plan.personas.map((p) => ({ id: p.accountId, label: p.label, steps: plan.steps.filter((s) => s.persona === p.accountId) })), { id: null, label: null, steps: plan.steps.filter((s) => !s.persona || !plan.personas.some((p) => p.accountId === s.persona)) }] : [{ id: null, label: null, steps: plan.steps }];
  const nets = [...new Set(plan.steps.filter((s) => s.rule === 'network').map((s) => s.why.split(' ')[0]))];

  return (
    <section class="org-plan" aria-label="Suggested layout">
      <header class="org-plan-head">
        <button class="org-plan-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          <h3>Suggested layout</h3>
        </button>
        <span class="set-help">{[nets.length ? `${nets.join(' and ')}'s folders` : '', split ? 'your accounts' : '', 'server names'].filter(Boolean).join(', ')}. Nothing you arranged moves.</span>
      </header>
      {open && (
        <>
          {split && !have && (
            <label class="org-plan-row org-plan-persona">
              <input type="checkbox" checked={personas} onChange={() => setPersonas(!personas)} />
              <Icon name="users" size={14} />
              <span class="org-plan-name">One folder per account</span>
              <span class="org-plan-why">{plan.personas.map((p) => `${p.label} (${p.spaces})`).join(' · ')}</span>
            </label>
          )}
          <div class="org-plan-tree">
            {groups
              .filter((g) => g.steps.length || g.id)
              .map((g) => (
                <div class={`org-plan-group ${g.id ? 'persona' : ''}`}>
                  {g.id && (
                    <div class="org-plan-acc" style={{ '--acc': db.accounts.get(g.id)?.color ?? '#8b93a7' } as any}>
                      <Icon name="folder" size={14} /> {g.label}
                      <span class="org-plan-why">its folders, then its other servers</span>
                    </div>
                  )}
                  {g.steps.map((s) => (
                    <label class={`org-plan-row ${off.has(s.id) ? 'off' : ''}`} style={{ '--folder': s.color ?? db.folders.find((f) => f.id === s.into)?.color ?? '#8b93a7' } as any}>
                      <input type="checkbox" checked={!off.has(s.id)} onChange={() => flip(s.id)} />
                      <span class="org-plan-icon">
                        <Icon name="folder" size={14} />
                      </span>
                      <span class="org-plan-name">
                        {s.into ? 'Add to ' : ''}
                        {s.name}
                        <span class="org-plan-count">{s.spaces.length}</span>
                      </span>
                      <span class="org-plan-why">
                        <Icon name={WHY_ICON[s.rule]} size={11} /> {s.why}
                      </span>
                      <span class="org-plan-members">
                        {s.spaces
                          .slice(0, 6)
                          .map((id) => db.spaces.get(id)?.name)
                          .filter(Boolean)
                          .join(', ')}
                        {s.spaces.length > 6 ? ` and ${s.spaces.length - 6} more` : ''}
                      </span>
                    </label>
                  ))}
                </div>
              ))}
          </div>
          <div class="org-plan-foot">
            <button class="btn primary small" disabled={!chosen.length && !(split && personas)} onClick={() => takePlan(plan, { steps: new Set(chosen.map((s) => s.id)), personas: split && personas })}>
              Apply: {made} {made === 1 ? 'folder' : 'folders'}, {servers} {servers === 1 ? 'server' : 'servers'} filed
            </button>
            <span class="set-help">{Object.keys(plan.suggest).length ? `${Object.keys(plan.suggest).length} servers no rule places: where they could go shows beside each below.` : ''}</span>
          </div>
        </>
      )}
    </section>
  );
}
