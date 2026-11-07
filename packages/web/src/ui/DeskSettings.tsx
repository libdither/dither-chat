/** Settings → Desktop helper: find dither-desk on this computer, pair with it, and choose what it opens. */
import { useEffect, useState } from 'preact/hooks';
import { android } from '../android.ts';
import { DESK_PORT, desk, hello, pair, setDesk, unpair } from '../desk.ts';

export function DeskSettings() {
  const s = desk.value;
  const [port, setPort] = useState(s?.port ?? DESK_PORT);
  // 'unchecked': not looked for yet. undefined: looking. null: nothing answered.
  const [found, setFound] = useState<{ version: string; paired: boolean } | null | undefined | 'unchecked'>(s ? undefined : 'unchecked');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = (p = port) => {
    setFound(undefined);
    void hello(p).then(setFound);
  };
  // Only a page that has paired looks for the helper by itself. An unpaired one asks only when you do, so opening
  // Settings never knocks on 127.0.0.1 for nothing: no refused connection, and no local-network prompt from the browser.
  useEffect(() => {
    if (s) check();
  }, [s?.token]);
  // The phone app opens links and files in the phone's apps already.
  if (android) return null;

  const answer = found === 'unchecked' ? undefined : found;
  const paired = !!s && !!answer?.paired;
  const status =
    found === 'unchecked' ? 'Not looked for yet. Start it on this computer, then look for it.'
    : found === undefined ? 'Looking for it…'
    : answer === null ? `Nothing answers on 127.0.0.1:${port}, or it is paired with another page.`
    : paired ? `Paired (dither-desk ${answer!.version}).`
    : s ? 'It answers, but no longer knows this page. Pair it again.'
    : answer!.paired ? 'It is paired with this address in another browser or profile. Pair again to use it here.'
    : `dither-desk ${answer!.version} is running and not paired.`;

  return (
    <section class="set-block" id="set-desk">
      <h3>Desktop helper</h3>
      <p class="set-help">
        dither-desk runs on this computer and opens links in your default browser and files in your own apps, instead of in the browser this app runs in. How to run it:
        docs/desktop.md, "Opening links and files in your own apps".
      </p>
      <p class="set-help" data-desk-status={paired ? 'paired' : found === 'unchecked' ? 'unchecked' : answer ? 'unpaired' : 'absent'}>{status}</p>
      {paired ? (
        <>
          <label class="toggle-row">
            <input type="checkbox" checked={s.links} onChange={(e) => setDesk({ ...s, links: (e.target as HTMLInputElement).checked })} />
            <span>
              <b>Open links in my default browser</b>
              <small>Links in messages and embeds, and Open Link in their menu. If the helper does not answer, they open here as before.</small>
            </span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" checked={s.files} onChange={(e) => setDesk({ ...s, files: (e.target as HTMLInputElement).checked })} />
            <span>
              <b>Open files in my apps</b>
              <small>A file is saved to Downloads/dither and opened with its default app. Open With… in a file's menu lists the others.</small>
            </span>
          </label>
          <div class="btn-row">
            <button class="btn ghost small" onClick={() => void unpair().then(() => check())}>Unpair</button>
          </div>
        </>
      ) : (
        <form
          class="keyword-add"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            void pair(port, code)
              .then((err) => (err ? setError(err) : (setCode(''), check())))
              .finally(() => setBusy(false));
          }}
        >
          <input
            class="input"
            style={{ maxWidth: '7em', flex: 'none' }}
            aria-label="Helper port"
            inputMode="numeric"
            value={String(port)}
            onChange={(e) => {
              const p = Number((e.target as HTMLInputElement).value) || DESK_PORT;
              setPort(p);
              check(p);
            }}
          />
          <input class="input" aria-label="Pairing code" placeholder="Code from: bun packages/desk/src/main.ts pair" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
          <button class="btn ghost small" disabled={busy || !code.trim()}>Pair</button>
        </form>
      )}
      {!paired && (
        <div class="btn-row">
          <button type="button" class="btn ghost small" disabled={found === undefined} onClick={() => check()}>
            Look for it
          </button>
        </div>
      )}
      {error && <p class="set-help">{error}</p>}
    </section>
  );
}
