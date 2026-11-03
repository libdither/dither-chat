/** Settings → Privacy: what the hub tells the networks about you (docs/typing.md). */
import { useEffect } from 'preact/hooks';
import { loadPrivacy, privacy, setShareTyping } from '../typing.ts';
import { ActivityLogSettings } from './ActivityLog.tsx';

export function PrivacySettings() {
  useEffect(() => void loadPrivacy(), []);
  const share = privacy.value?.shareTyping ?? true;
  return (
    <section class="set-block" id="set-privacy">
      <h3>Privacy</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={share} disabled={!privacy.value} onChange={(e) => void setShareTyping((e.target as HTMLInputElement).checked)} />
        <span>
          <b>Show others when I'm typing</b>
          <small>
            On every network, through the account you are writing as. WhatsApp may not pass it on, because dither-chat never
            marks your account online there (that would stop your phone's notifications). Off: nobody sees you typing, and
            you still see others.
          </small>
        </span>
      </label>
      <ActivityLogSettings />
    </section>
  );
}
