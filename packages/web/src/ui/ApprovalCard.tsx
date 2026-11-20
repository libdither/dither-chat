/**
 * One approval request (docs/approvals.md) inside its notice: what a service asks, its body and payload, a message
 * box, and one button per action. Actions that need no signature (Deny, and what the asker marked `any`) are answered
 * here; one that needs a signature goes to the laptop signer, which asks for your finger, else it says to answer on
 * the phone. While it waits it follows the request with long polls, so an answer from the phone shows at once.
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { ago } from '../format.ts';
import { Icon } from './icons.tsx';
import './approval.css';

interface ActionDef {
  id: string;
  label: string;
  needs: 'signed' | 'any';
}

/** GET /api/approvals/:id (the hub's approvals.ts ApprovalView), as much as this shows. */
interface Approval {
  id: string;
  kind: string;
  asker: string;
  title: string;
  body: string;
  payload: string;
  actions: ActionDef[];
  created: number;
  expires: number;
  state: 'waiting' | 'answered' | 'expired' | 'cancelled' | 'sent';
  action: string | null;
  message: string | null;
  signed: boolean;
  device: { id: string; name: string; kind: string } | null;
  via: 'device' | 'page' | null;
  cancelReason: string | null;
  signing: string | null;
}

const KIND: Record<string, string> = { rebuild: 'Rebuild', deploy: 'Deploy', merge: 'Merge', policy: 'Standing approval', alert: 'Alert' };

const until = (t: number) => {
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
};

function outcome(a: Approval): string {
  if (a.state === 'expired') return 'Expired without an answer';
  if (a.state === 'cancelled') return `Cancelled${a.cancelReason ? `: ${a.cancelReason}` : ''}`;
  if (a.state === 'sent') return 'An alert: nothing to answer';
  const label = a.actions.find((x) => x.id === a.action)?.label ?? a.action ?? '';
  const where = a.via === 'page' ? 'here' : `on ${a.device?.name ?? 'a device'}`;
  return `${label}, ${where}${a.signed ? ', signed' : ''}`;
}

export function ApprovalCard({ id }: { id: string }) {
  const [a, setA] = useState<Approval | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Follow it while it waits: a long poll at a time, until it ends or the card goes.
  useEffect(() => {
    let live = true;
    void (async () => {
      let wait = 0;
      while (live) {
        try {
          const v = await api<Approval>(`/api/approvals/${id}${wait ? `?wait=${wait}` : ''}`);
          if (!live) return;
          setA(v);
          setErr(null);
          if (v.state !== 'waiting') return;
          wait = 50;
        } catch (e: any) {
          if (!live) return;
          setErr(String(e?.message ?? e));
          if (e?.status === 404) return;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
    return () => void (live = false);
  }, [id]);

  const answer = async (act: ActionDef) => {
    setBusy(act.id);
    setErr(null);
    try {
      const r = await api<{ answered: boolean; signing: boolean; request: Approval }>(`/api/approvals/${id}/answer`, { body: { action: act.id, message: message.trim() || undefined } });
      setA(r.request);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  if (!a) return <div class="approval-card loading">{err ?? 'Loading the request…'}</div>;
  const waiting = a.state === 'waiting';
  return (
    <div class={`approval-card state-${a.state}`} data-approval={a.id}>
      <div class="approval-meta">
        <span class="approval-kind">{KIND[a.kind] ?? a.kind}</span> asked by <b>{a.asker}</b> · {ago(a.created)}
        {waiting && <> · expires in {until(a.expires)}</>}
      </div>
      {a.body && <pre class="approval-body">{a.body}</pre>}
      {a.payload && (
        <details class="approval-payload">
          <summary>What a signature covers</summary>
          <pre>{a.payload}</pre>
        </details>
      )}
      {waiting ? (
        <>
          {a.signing && (
            <div class="approval-signing" role="status">
              <Icon name="lock" size={14} /> Touch the laptop's fingerprint reader to sign “{a.actions.find((x) => x.id === a.signing)?.label ?? a.signing}”, or answer on your phone.
            </div>
          )}
          <textarea class="approval-message" rows={2} maxLength={1000} placeholder="A message back (optional)" value={message} onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
          <div class="notice-actions approval-actions">
            {a.actions.map((act) => (
              <button
                key={act.id}
                class={`chip-btn ${act.id === 'deny' ? 'deny' : act.needs === 'signed' ? 'primary' : ''}`}
                data-act={act.id}
                disabled={!!busy}
                title={act.needs === 'signed' ? 'Needs a signature: your phone, or the laptop signer' : undefined}
                onClick={() => void answer(act)}
              >
                {act.needs === 'signed' && <Icon name="lock" size={13} />} {busy === act.id ? '…' : act.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div class="approval-outcome">
          <Icon name={a.state === 'answered' && a.action !== 'deny' ? 'check' : 'x'} size={14} /> {outcome(a)}
          {a.message && <div class="approval-said">“{a.message}”</div>}
        </div>
      )}
      {err && (
        <div class="approval-error" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
