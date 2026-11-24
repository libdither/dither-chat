/**
 * Nothing makes a page scroll sideways (docs/testing.md, "Sideways overflow"). A box that scrolls up and down scrolls
 * sideways too as soon as anything in it is wider than it is: one long unbroken word in a row whose flex or grid item
 * keeps its min-content width (`min-width: auto`, a `1fr` track) grows a scrollbar under a whole chat, and a focus or a
 * `scrollIntoView` can then shift the chat sideways. This walks the demo world's pages at a computer's size (and with the details
 * panel open), a narrow window's and a phone's in headless Chromium, and fails when
 *
 *   - a box that scrolls up and down is wider inside than it is (as drawn, the demo's own text), or
 *   - one text from the hub (a name, a message, a title: a string in an /api/ answer), made 40 characters longer with
 *     an unbroken word, makes one so. The app's own words (a button's label, a time, a count) are its to keep short.
 *
 * Each text is tried once per kind of place it sits in (its chain of classes), so a list of a hundred rows costs one row.
 * A box meant to scroll sideways is one whose rule sets `overflow-x` alone (a code block, a row of chips), or is in
 * SIDEWAYS. The chat's safety net (`.timeline-inner`'s `overflow-x: clip`) is turned off while it looks, so it still
 * sees what the net would hide.
 *
 *   bun scripts/check-overflow.ts [--web <built dist>] [--only <hash substring>] [--keep]     (bun run check:overflow)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "./browser.ts";

const args = process.argv.slice(2);
const opt = (k: string, d = "") =>
  args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d;
const root = resolve(import.meta.dir, "..");

/** Boxes that scroll sideways on purpose: what they hold is wide by nature and is read by scrolling it. */
const SIDEWAYS = [
  "pre",
  ".md-code",
  ".md-table-wrap",
  ".chips-scroll",
  ".tabs",
  ".ep-rail",
  ".code-scroll",
];
/** Safety nets that clip sideways overflow, turned off while looking (see the header). */
const NETS = [".timeline-inner"];
/** Window sizes, and whether the chat's details panel is open beside it (narrowing the chat the most). */
const SIZES: [string, number, number, boolean][] = [
  ["computer", 1280, 860, false],
  ["details", 1100, 800, true],
  ["narrow", 840, 760, false],
  ["phone", 390, 800, false],
];
const LONG = " " + "x".repeat(40);

const work = mkdtempSync(join(tmpdir(), "dither-check-overflow-"));
const web = opt("web") || join(work, "web");
let hub: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof launch>> | undefined;
const problems = new Map<string, string>();

function freePort(): number {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** Runs in the page: the boxes that scroll sideways and should not, and (with `stress`) which texts make one. */
const LOOK = (stress: boolean, data: string[]) => `(() => {
  const words = new Set(${JSON.stringify(data)});
  const blob = [...words].join('\\n');
  // From the hub: the whole of one of its strings, or (a longer text) a piece of one, as a message's text is.
  const fromHub = (t) => /\\p{L}/u.test(t) && t.length >= 3 && (words.has(t) || (t.length >= 12 && blob.includes(t)));
  const net = document.getElementById('overflow-check-nets') ?? Object.assign(document.head.appendChild(document.createElement('style')), { id: 'overflow-check-nets' });
  net.textContent = ${JSON.stringify(NETS.map((n) => `${n} { overflow-x: visible !important; }`).join("\n"))};
  const name = (e) => e.tagName.toLowerCase() + [...e.classList].filter((c) => !/^(on|open|mine|self|head|grouped|active|sel|hover|unread|new)$/.test(c)).map((c) => '.' + c).join('');
  // A rule that sets overflow-x to scroll on its own (not with overflow-y) makes a box that scrolls sideways on purpose.
  const meant = [];
  const rules = (list) => { for (const r of list) { if (r.cssRules && !r.selectorText) rules(r.cssRules); else if (r.selectorText && /auto|scroll/.test(r.style.overflowX) && !/auto|scroll/.test(r.style.overflowY)) meant.push(r.selectorText); } };
  for (const sh of document.styleSheets) { try { rules(sh.cssRules); } catch {} }
  const sideways = [${JSON.stringify(SIDEWAYS.join(","))}, ...meant].join(',');
  const scrollers = [...document.querySelectorAll('*')].filter((e) => {
    const s = getComputedStyle(e);
    return (s.overflowX === 'auto' || s.overflowX === 'scroll') && e.clientWidth > 0 && !e.matches(sideways) && !e.closest('.menu, .emoji-picker');
  });
  const over = (s) => s.scrollWidth - s.clientWidth > 1;
  const out = [];
  for (const s of scrollers) if (over(s)) out.push({ box: name(s), what: 'as drawn', by: s.scrollWidth - s.clientWidth });
  if (!${stress}) return out;
  const seen = new Set();
  for (const s of scrollers) {
    if (over(s)) continue;
    const walk = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walk.nextNode()) texts.push(walk.currentNode);
    for (const t of texts) {
      const el = t.parentElement;
      if (!fromHub(t.nodeValue.trim()) || !el || el.closest(sideways) || el.getClientRects().length === 0) continue;
      if (el.closest('svg, script, style, textarea')) continue;
      let chain = [];
      for (let x = el; x && x !== s && chain.length < 4; x = x.parentElement) chain.push(name(x));
      const key = chain.join(' < ');
      if (seen.has(key)) continue;
      seen.add(key);
      const old = t.nodeValue;
      t.nodeValue = old + ${JSON.stringify(LONG)};
      if (over(s)) out.push({ box: name(s), what: key, by: s.scrollWidth - s.clientWidth });
      t.nodeValue = old;
    }
  }
  return out;
})()`;

/**
 * One page's look, given PAGE_MS. A DevTools call that never answers (a page whose script never yields, a body the
 * browser never hands over) otherwise holds the whole run until CI cancels it, saying nothing of where. Past the time
 * this pauses the page's script and prints where it is, then fails naming the page.
 */
const PAGE_MS = 90_000;
/** What the page's look is waiting on, for when it waits too long. */
let step = "";
async function within(
  what: string,
  p: Awaited<ReturnType<typeof launch>>["page"],
  run: () => Promise<void>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">(
    (res) => (timer = setTimeout(() => res("late"), PAGE_MS)),
  );
  const done = await Promise.race([run().then(() => "done" as const), late]);
  clearTimeout(timer);
  if (done === "done") return;
  let where = "(the page's script could not be paused)";
  const paused = new Promise<string>((res) =>
    p.on("Debugger.paused", (e) =>
      res(
        (e.callFrames ?? [])
          .slice(0, 12)
          .map(
            (f: any) =>
              `    at ${f.functionName || "(anonymous)"} ${f.url}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`,
          )
          .join("\n") ||
          "    (paused, no frames: the page is idle, so a DevTools answer was lost)",
      ),
    ),
  );
  void p.send("Debugger.enable").catch(() => {});
  void p.send("Debugger.pause").catch(() => {});
  where = await Promise.race([paused, Bun.sleep(5_000).then(() => where)]);
  const answers = await Promise.race([
    p.send("Runtime.evaluate", { expression: "1" }).then(
      () => "answers",
      (e) => `fails (${e.message})`,
    ),
    Bun.sleep(3_000).then(() => "does not answer"),
  ]);
  throw new Error(
    `${what} did not finish in ${PAGE_MS / 1000} s, waiting on ${step}; the page ${answers} a plain evaluate; its script was at:\n${where}`,
  );
}

try {
  if (!opt("web")) {
    const b = Bun.spawnSync(
      ["bunx", "--bun", "vite", "build", "--outDir", web, "--emptyOutDir"],
      { cwd: join(root, "packages/web"), stdout: "pipe", stderr: "pipe" },
    );
    if (b.exitCode !== 0)
      throw new Error(`web build failed:\n${b.stderr.toString().slice(-2000)}`);
  }
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("DITHER_")),
  );
  hub = Bun.spawn(
    [
      "bun",
      join(root, "packages/hub/src/main.ts"),
      "--demo",
      "--data",
      join(work, "data"),
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--web",
      web,
    ],
    {
      env: {
        ...env,
        DITHER_DEMO_CHATTER: "0",
        DITHER_CATEGORY_MODEL: "keyword",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let boot: any;
  for (let i = 0; i < 300 && !boot; i++) {
    boot = await fetch(`${base}/api/bootstrap`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!boot) await Bun.sleep(100);
  }
  if (!boot) throw new Error("the demo hub did not start");

  // One chat of each network and shape, then the other pages.
  const chats = new Map<string, string>();
  for (const c of boot.conversations)
    if (!chats.has(`${c.network} ${c.shape}`))
      chats.set(`${c.network} ${c.shape}`, c.id);
  const person = boot.persons.find((p: any) => p.id !== boot.selfPersonId)?.id;
  // Each page with what shows once it has drawn what it holds.
  const pages: [string, string][] = (
    [
      ["#/inbox", ".side-scroll .row"],
      // A notifications conversation opens Activity: an event site's (docs/events.md) holds only the site's notices,
      // drawn as slim rows (.feed-unit).
      ...[...chats.values()].map((id): [string, string] => [
        `#/c/${encodeURIComponent(id)}`,
        ".msg, .feed-entry, .thread-post, .feed-unit",
      ]),
      ...[...chats.values()]
        .slice(0, 3)
        .map((id): [string, string] => [
          `#/about/c/${encodeURIComponent(id)}`,
          ".pf-card",
        ]),
      ...(person
        ? [
            [`#/p/${encodeURIComponent(person)}`, ".pf-card"] as [
              string,
              string,
            ],
          ]
        : []),
      ["#/people", ".side-scroll .row"],
      ["#/spaces", ".side-scroll .row"],
      ["#/accounts", ".acc-row"],
      ["#/settings", ".set-block"],
      ["#/foryou", ".foryou, .empty"],
      ["#/feed", ".feed-entry, .empty"],
      ["#/inbox?mail=v%3Aupdates%3A*", ".mail-row, .empty"],
      ["#/notices", ".notice-card, .empty"],
      ["#/requests", ".request-card, .empty"],
      ["#/directory", ".dir-card, .empty"],
      ["#/model", ".board-block"],
      ["#/search?q=the", ".search-hit"],
    ] as [string, string][]
  ).filter(([h]) => !opt("only") || h.includes(opt("only")));

  browser = await launch();
  const p = browser.page;
  // Every string the hub sends, to tell its texts from the app's own words.
  const data = new Set<string>();
  const json = new Set<string>();
  const leaves = (v: unknown): void => {
    if (typeof v === "string")
      v.length >= 3 && v.length < 4000 && data.add(v.trim());
    else if (Array.isArray(v)) v.forEach(leaves);
    else if (v && typeof v === "object") Object.values(v).forEach(leaves);
  };
  const reading: Promise<unknown>[] = [];
  p.on(
    "Network.responseReceived",
    (e) =>
      e.response.url.includes("/api/") &&
      e.response.mimeType.includes("json") &&
      json.add(e.requestId),
  );
  p.on("Network.loadingFinished", (e) => {
    if (!json.delete(e.requestId)) return;
    reading.push(
      p
        .send<{ body: string }>("Network.getResponseBody", {
          requestId: e.requestId,
        })
        .then((r) => leaves(JSON.parse(r.body)))
        .catch(() => {}),
    );
  });
  for (const [size, w, h, details] of SIZES) {
    await p.size(w, h);
    await p.goto(`${base}/#/inbox`);
    await p.until(`!!document.querySelector('.app')`, 15_000);
    await p.eval(
      `localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), details: ${details} }))`,
    );
    await p.send("Page.reload");
    await p.until(`!!document.querySelector('.app')`, 15_000);
    for (const [hash, shown] of pages) {
      const t0 = performance.now();
      await within(`${size} ${hash}`, p, async () => {
        step = "navigating";
        await p.goto(`${base}/${hash}`);
        step = `what shows: ${shown}`;
        await p.until(
          `!!document.querySelector(${JSON.stringify(shown)})`,
          15_000,
        );
        // Whatever the page asked the hub for has been read before its texts are told apart.
        step = `${reading.length} response bodies`;
        await Promise.all(reading.splice(0));
        for (const pass of [false, true]) {
          step = `the look, ${pass ? "with longer texts" : "as drawn"}`;
          const found = await p.eval<
            { box: string; what: string; by: number }[]
          >(LOOK(pass, pass ? [...data] : []));
          for (const f of found) {
            const key = `${f.box} ← ${f.what}`;
            if (!problems.has(key))
              problems.set(
                key,
                `${size} ${hash}: ${f.box} scrolls sideways by ${f.by}px ${pass ? `with a longer text in ${f.what}` : "(as drawn)"}`,
              );
          }
        }
      });
      const ms = performance.now() - t0;
      if (ms > 10_000)
        console.log(`slow: ${size} ${hash} took ${(ms / 1000).toFixed(1)} s`);
    }
  }
} finally {
  await browser?.close().catch(() => {});
  hub?.kill();
  await hub?.exited;
  if (!args.includes("--keep")) rmSync(work, { recursive: true, force: true });
}

if (problems.size) {
  console.log(`${problems.size} places scroll sideways:`);
  for (const line of problems.values()) console.log(`  ${line}`);
  process.exit(1);
}
console.log("no page scrolls sideways");
