# Translation

Posts in another language are translated, by themselves or on asking, and shown under the original or in its place.
One feature with providers behind it: a network that translates its own posts is one, a translation server you run is
another.

## Providers

- **The network's own** (capability `translate`, the `translate` command, `NetworkTranslation`): X translates a post the
  way its "Translate post" link does (the post actions' `fetchTranslation`, which X answers with Grok, Google or
  Papago). Only for a post of that network, by its id. The label says who: "Grok via X".
- **A translation server**: any server with LibreTranslate's API (`POST <url>/translate` with `{q, source, target,
  format: 'text'}`, answering `{translatedText, detectedLanguage}`), so LibreTranslate itself, or a local model behind
  the same API. It translates anything: a network's post where the network cannot, a text that is no network's post.

Settings say which is asked first (`provider`: `network` or `server`); the other is the fallback. With neither, the post
stays as written and says why.

## The hub (`packages/hub/src/translate.ts`)

- `GET /api/translate/settings` → `{settings, networks}` (the networks that can translate their own posts now);
  `PUT` changes some settings, each checked (`to` a language tag, `show` below or replace, `provider`, `serverUrl` an
  http or https address with no credentials).
- `POST /api/translate {items: [{key, text, lang?, network?, post?}], to?}` → `{translations: [{key, text, from, by}],
  failed: [{key, why}]}`: at most 40 texts of 5,000 characters, three at a time. `to` defaults to the settings'.
- What came back is kept in memory (by target, network, post and text), so a thread opened again or a post in two
  places is asked once; a change of target, provider or server forgets it. Nothing is written to the database.

Settings are kept in `meta` (`translate`): `auto` (on by default), `to` (`en`), `show` (`below`), `provider`
(`network`), `serverUrl` (none).

## The page

A post's text (`ui/feed/Post.tsx` `Text`) is translated when the network says it is in a language other than the
target (`PostFact.lang`, X's `legacy.lang`; `und`, media-only and hashtag-only are no language: `needsTranslation`) and
a provider can do it. The asks of one render go together (`ui/feed/translate.ts`).

- **Under the original**: the text as written, then a soft box: "Translated from Japanese by Grok via X · Hide", and
  the translation. Hide leaves "Show translation".
- **In its place**: the translation is the text, with "Translated from Japanese by Grok via X · Show original" under
  it; Show original brings the text as written back ("Written in Japanese · Show translation").
- **Not by itself** (`auto` off): a "Translate post" link, as X has.
- While it is asked: "Translating from Japanese…"; when it fails: why, and Try again.

Settings → Translation: by themselves or not, into which language, under or in place, who first, and the server's
address with a Test (it translates a line of French through the server).

## Tests

- `packages/hub/test/translate.test.ts`: the network's translation and its label, asked once; per-item failures; the
  server asked LibreTranslate's way, first or as the fallback; settings checked and kept; the call's limits.
- `scripts/verify-x-threads.ts`: replies in Japanese and Spanish translated under the original, Hide, in place with
  Show original and back, nothing asked twice, Translate post with automatic translation off, and Settings →
  Translation.
