/**
 * Importing a DiscordChatExporter HTML export: the reader on a synthetic export (made-up ids, written in DCE's own
 * markup), then the whole run through the hub — fill-only, no unread counts, conflicts kept, a rerun that changes
 * nothing, and undo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as P from "@dither-chat/protocol";
import { hubId } from "@dither-chat/protocol/ids";
import {
  markdown,
  parseDceTime,
  readDceHtml,
} from "../src/imports/discord-html.ts";
import { parseFragment } from "../src/imports/html.ts";
import { ImportRunner } from "../src/imports/engine.ts";
import { ImportSources } from "../src/imports/sources.ts";
import { mediaSigner } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { dceExport, writeDceExport } from "./fixtures/dce-export.ts";

const { ME, PEER, DM, CHAN, T, M1, M2, M3, M6 } = dceExport();

const dir = mkdtempSync(join(tmpdir(), "dither-dce-"));
const raw = join(dir, "data/imports/sources/discord-test/raw");

beforeAll(
  () => void writeDceExport(join(dir, "data/imports/sources/discord-test")),
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("reader", () => {
  test("a DM and a server channel become the adapter’s facts", () => {
    const batches = [...readDceHtml({ rawDir: raw, selfId: ME })];
    const dm = batches.find((b) => b.conversation.nativeId === DM)!;
    expect(dm.conversation).toEqual({
      nativeId: DM,
      shape: "direct",
      participants: [ME, PEER],
    });
    const [m1, m2, m3, m4] = dm.messages;
    expect(m1).toMatchObject({
      nativeId: M1,
      author: PEER,
      ts: T,
      kind: "text",
      body: `hello **there** <@${ME}> <:wave:123456789012345678>`,
      mentionsSelf: true,
    });
    expect(m2.kind).toBe("media");
    expect(m2.attachments![0]).toMatchObject({
      kind: "image",
      name: "photo.png",
    });
    expect(m2.attachments![0].url).toBe(
      `file://${raw}/Pictures/Discord-test-images/photo-1a2b3.png`,
    );
    expect(m2.reactions).toEqual([{ key: "👍", count: 2, authors: [] }]);
    expect(m3).toMatchObject({
      author: ME,
      replyTo: M1,
      body: "a `x` & [site](https://example.org)",
    });
    expect(m3.editedTs).toBe(parseDceTime("Tuesday, June 1, 2021 12:30 PM"));
    expect(m4).toMatchObject({
      kind: "media",
      body: "",
      attachments: [{ kind: "video", name: "tenor.mp4" }],
    });
    expect(dm.identities.find((i) => i.nativeId === PEER)).toMatchObject({
      handle: "peer",
      displayName: "Peer",
    });

    const chan = batches.find((b) => b.conversation.nativeId === CHAN)!;
    expect(chan.conversation).toEqual({
      nativeId: CHAN,
      shape: "channel",
      name: "chat",
    });
    expect(chan.guild).toBe("Some Server");
  });

  test("Markdown comes back from the rendered HTML", () => {
    const md = (h: string) =>
      markdown(parseFragment(h), new Map([["someone", "42"]]));
    expect(
      md(
        '<em>a</em> <u>b</u> <s>c</s> <span class="chatlog__markdown-spoiler chatlog__markdown-spoiler--hidden">d</span>',
      ),
    ).toBe("*a* __b__ ~~c~~ ||d||");
    expect(
      md(
        '<div class="chatlog__markdown-quote"><div class=chatlog__markdown-quote-border></div><div class=chatlog__markdown-quote-content>q1<br>q2</div></div>after',
      ),
    ).toBe("> q1\n> q2\nafter");
    expect(
      md(
        '<div class="chatlog__markdown-pre chatlog__markdown-pre--multiline language-ts">let x = 1;\n</div>',
      ),
    ).toBe("```ts\nlet x = 1;\n```");
    expect(
      md(
        "<span class=chatlog__markdown-mention title=someone>@Some One</span> <span class=chatlog__markdown-mention title=nobody>@Nobody</span> <span class=chatlog__markdown-mention>#general</span>",
      ),
    ).toBe("<@42> @Nobody #general");
    expect(md('<a href="https://x.org/a">https://x.org/a</a>')).toBe(
      "https://x.org/a",
    );
  });
});

describe("import into the hub", () => {
  let store: Store;
  let sources: ImportSources;
  let runner: ImportRunner;
  let acc: any;
  const data = join(dir, "data");
  const run = async (dryRun: boolean): Promise<P.ImportRunView> => {
    runner.start("discord-test", { dryRun });
    for (let i = 0; i < 400; i++) {
      const r = sources.view("discord-test")!.run!;
      if (r.finishedAt) return r;
      await Bun.sleep(10);
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    store = new Store(join(data, "hub.sqlite"), mediaSigner("s"));
    acc = store.createAccount({
      id: "acc_dc",
      network: "discord",
      label: "main",
      color: "#000",
      adapter: "discord",
    });
    store.ingest(acc, {
      t: "status",
      status: "online",
      self: { nativeId: ME, isSelf: true, displayName: "Me" },
    });
    acc = store.account("acc_dc");
    // Live sync already has the server channel, one message the export also has (worded differently), and a read state.
    store.ingest(acc, {
      t: "conversation",
      conversation: { nativeId: CHAN, shape: "channel", name: "chat" },
    });
    store.ingest(acc, {
      t: "message",
      live: true,
      message: {
        nativeId: M6,
        conversation: CHAN,
        author: PEER,
        ts: T + 300_000,
        body: "the live words",
      },
    });
    store.ingest(acc, {
      t: "read",
      conversation: CHAN,
      upToTs: 0,
      unread: 7,
      mentions: 1,
    });
    store.flush();
    sources = new ImportSources(data);
    await sources.check("discord-test");
    sources.patch("discord-test", { accountId: "acc_dc" });
    runner = new ImportRunner(store, sources, data);
  });
  afterAll(() => store.db.close());

  test("a dry run counts and writes nothing", async () => {
    const r = await run(true);
    expect(r.stage).toBe("done");
    expect(r.counts).toMatchObject({
      conversations: 2,
      conversationsNew: 1,
      messages: 6,
      new: 5,
      conflicts: 1,
    });
    expect(
      r.counts!.new + r.counts!.same + r.counts!.conflicts + r.counts!.filled,
    ).toBe(6);
    expect(store.db.query("SELECT COUNT(*) AS n FROM message").get()).toEqual({
      n: 1,
    });
  });

  test("the import fills in what the hub lacks and leaves the rest alone", async () => {
    const r = await run(false);
    expect(r.counts).toMatchObject({ new: 5, same: 0, conflicts: 1 });
    expect(r.files).toEqual({ linked: 3, missing: 0 });
    const m1 = store.db
      .query("SELECT * FROM message WHERE id = ?")
      .get(hubId("msg", "discord", M1)) as any;
    expect(m1).toMatchObject({ imported: 1, ts: T, deleted: 0 });
    // The live message keeps its words; the export's are kept for review.
    expect(
      store.db
        .query("SELECT body, imported FROM message WHERE id = ?")
        .get(hubId("msg", "discord", M6)) as any,
    ).toEqual({ body: "the live words", imported: 0 });
    const v = sources.view("discord-test")!;
    const conflicts = store.importConflicts(v.sha256!);
    expect(conflicts).toMatchObject([
      {
        kind: "body",
        hub: { body: "the live words" },
        source: { body: "live says otherwise" },
      },
    ]);
    // Unread counts are the network's, before and after.
    expect(
      store.db
        .query(`SELECT unread, mentions FROM vantage WHERE target_id = ?`)
        .get(hubId("cnv", "discord", CHAN)),
    ).toEqual({ unread: 7, mentions: 1 });
    const dm = store.db
      .query(
        `SELECT c.archived, v.unread, v.last_read_ts FROM conversation c JOIN vantage v ON v.target_id = c.id WHERE c.id = ?`,
      )
      .get(hubId("cnv", "discord", DM)) as any;
    expect(dm).toEqual({ archived: 1, unread: 0, last_read_ts: T + 180_000 });
    // Media went into the store, by content, and the source can go without breaking it.
    const url = (
      store.db
        .query("SELECT url FROM attachment WHERE message_id = ?")
        .get(hubId("msg", "discord", M2)) as any
    ).url as string;
    expect(url).toMatch(
      new RegExp(
        `^file://${data}/imports/media/[0-9a-f]{2}/[0-9a-f]{64}\\.png$`,
      ),
    );
    expect(readFileSync(url.slice(7), "utf8")).toBe("bytes of photo-1a2b3.png");
    expect(statSync(url.slice(7)).nlink).toBe(2);
  });

  test("a second run changes nothing", async () => {
    const before = store.db.query("SELECT COUNT(*) AS n FROM message").get();
    const r = await run(false);
    expect(r.counts).toMatchObject({ new: 0, same: 5, conflicts: 1 });
    expect(store.db.query("SELECT COUNT(*) AS n FROM message").get()).toEqual(
      before,
    );
  });

  test("a conflict can take the source’s words, keeping the hub’s as an earlier version", () => {
    const sha = sources.view("discord-test")!.sha256!;
    store.decideImportConflict(
      hubId("msg", "discord", M6),
      "body",
      sha,
      "take-source",
    );
    expect(
      (
        store.db
          .query("SELECT body FROM message WHERE id = ?")
          .get(hubId("msg", "discord", M6)) as any
      ).body,
    ).toBe("live says otherwise");
    expect(
      store.db
        .query(
          `SELECT json_extract(data, '$.body') AS b FROM message_event WHERE message_id = ? AND kind = 'edit'`,
        )
        .get(hubId("msg", "discord", M6)),
    ).toEqual({ b: "the live words" });
  });

  test("undo takes out only what the import alone brought", () => {
    const sha = sources.view("discord-test")!.sha256!;
    expect(store.undoImport(sha)).toEqual({ removed: 5 });
    expect(
      (store.db.query("SELECT COUNT(*) AS n FROM message").get() as any).n,
    ).toBe(1);
  });
});
