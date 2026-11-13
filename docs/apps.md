# Bots and apps: buttons, selects, slash commands and forms

A bot's message can carry buttons and selects ([rich-messages.md](rich-messages.md)). A server can have bots whose
commands you type after a slash. A bot can answer either by opening a form. dither does all three from its own page,
through the account's own client, the way a click in that client would. Discord is the only network with them today;
the shapes are the protocol's (`packages/protocol/src/apps.ts`).

## What you can do

| What | Where | What happens |
|---|---|---|
| Press a button | under a bot's message | It goes once. While it waits, the message's buttons are off and a line under them says "Sending…"; then "The bot answered", "The bot opened a form", "This interaction failed" (with Discord's reason when it gives one) or "No answer came back". Link buttons open their link, as before |
| Choose in a select | under a bot's message | A select of the bot's options lists them. Picking from a one-choice select sends at once; a many-choice one has a Choose button and says how many it takes. A select of people, roles or channels lists the ones the hub already knows there (below), with a search box |
| Run a slash command | the composer: type `/` | The commands your account may run in that channel, as Discord's own client lists them, with their app. Arrows and Enter or Tab pick one, or tap it. Its options show as fields over the box: text, numbers with their limits, yes or no, the app's choices as a list, people, roles and channels to pick, and the app's suggestions as you type where it has them. Enter (or the send button on a phone) runs it; Esc puts the command down. Words typed after the command fill its first text option. A body that names no picked command is sent as text, as ever |
| Answer a form | a dialog, when a bot opens one | Its fields as the bot gave them: short and long text, selects, radio buttons, check boxes, and its words. Required fields are marked and checked as you fill them in. Send sends it once; Cancel leaves it. A form can be sent up to 15 minutes after it opened |
| Run an app's message command | a message's menu: **Apps** | The apps' commands for messages (Discord's Apps menu on a message), in a dialog; one tap runs it on that message |

What the bot answers comes as any message does. An answer only you can see (Discord's ephemeral answers) shows in the
timeline with "Only you" beside its time. The hub keeps it like any message, though Discord's own client forgets it
when it reloads.

## The rules

- **One click, one request.** Every press, choice, command and form is one interaction the owner caused, sent once.
  Nothing is retried, by the page, the hub or the adapter, not even after a rate limit. A second press on the same
  message waits until the first is answered (Discord's own client refuses it too).
- **Never by itself.** Nothing presses, chooses, runs or answers anything without the owner's click. A bot's labels,
  options, form texts and messages are untrusted: they are shown, never followed. A "press this" in a bot's text
  does nothing.
- **Checked before it goes.** The hub checks each one against what it has: the message and its controls as stored
  (the control is there, not turned off, not a link; a select's values are among its options, as many as it takes),
  the commands the account's adapter last listed for that channel (options known, required ones given, numbers in
  range, choices among the app's), the form as the bot opened it (fields known, required ones filled, lengths, open
  for 15 minutes, sent once). A write comes only from the app's own page.
- **Links stay links.** A link button opens its address in a new tab as before (http and https only).

## Picking people, roles and channels

A select of people, roles or channels, a command option of those kinds, and a form's select of them list only what
the hub already knows of the place: people who wrote there lately, a group's members and the members the hub keeps
for the server (with the adversarial members setting on), the server's roles as its About last said, and its channels.
The hub asks nobody for members to fill these. For a command option you can also type a name; Discord's own client
resolves it, as it would one typed there.

## Not built

- **Files** in a command option or a form: run the command or answer the form on Discord. The page says so where one
  is asked for.
- **User commands** (an app's commands on a person, from a profile): they need a place to run in, which a profile
  does not have. Message commands are built.
- **Activities** a command or button launches, and forms an app shows as its own page (Discord's iframe modals): the
  interaction says it failed and why; answer it on Discord.
- **Premium buttons** (buying something from an app).

## How it goes, end to end

1. The page posts to `/api/conversations/:id/apps/interact` (a press, a command or a form, in hub ids). The hub checks
   it, turns picks into native ids, and sends the account's adapter one `interact` command.
2. The adapter's hook runs it through the client's own code (below) and answers with the interaction's nonce.
3. As it goes, the adapter sends `interaction` events (sending, answered, failed, timedOut, modal) and, for a form, an
   `appModal` event. The hub passes them to the page as they come (`interaction` and `appModal` page events) and keeps
   only the forms still open, in memory, to check an answer against.

Commands are listed with `GET /api/conversations/:id/apps/commands?kind=chat|message`, suggestions with
`POST …/apps/autocomplete`, picks with `GET …/apps/choices?select=user|role|channel|mentionable&q=`, and open forms
with `GET …/apps/forms`.

### Capabilities

An adapter offers each only when it found what it needs: `interactComponents` (presses and choices),
`interactCommands` (slash commands and their suggestions), `interactContext` (message commands), `interactModals`
(forms). An older adapter has none of them, and the page then draws a bot's controls as it did before: shown, not
pressable, and no `/` list.

## Discord specifics

What the Discord extractor (dither-accounts `extractors/discord`, hook.js "bots and apps") uses, all the client's
own, read from build 671535:

- A press or a choice: the client's `executeMessageComponentInteraction`. It makes the nonce, sends the session id,
  the message's flags and the application id, and refuses a second press while one waits. The message comes from the
  client's message store, else from what the hook heard, else from one read of the channel around it (as jumping to
  it reads it).
- The command list: the client's `ApplicationCommandIndexStore.query`, as typing `/` runs it: each place's index (the
  server's, or a DM's, and your own apps') loaded once and kept; the client's permission checks applied; its built-in
  commands (`/nick`, `/me` and the like) left out.
- Running a command and its suggestions: the client's `executeCommand`, which parses and checks the options as its
  composer hands them over; with an autocomplete context it asks the app for suggestions instead, and the gateway's
  answer to its nonce comes back.
- A form: the client sends it only from inside its own dialog (a React hook in a lazy chunk), so the hook does what
  that dialog does: the client's `queueInteraction`, its snowflake nonce, its session id, and its REST helper with the
  body the dialog builds. A refusal is told to the client's stores with its own failure action.
- Outcomes: `INTERACTION_SUCCESS`, `INTERACTION_FAILURE`, `INTERACTION_MODAL_CREATE`, and a `MESSAGE_CREATE`
  carrying the nonce, matched to the hook's own nonces only (a click in the live view is the live view's). Nothing
  back in 15 seconds is a timeout.
- The client's local notices (Clyde, author `1`: a failed send or interaction said only on that screen) are no
  longer taken for messages.

## What was checked, and what needs a live check

Checked: the extractor against a replica of the client's modules (`extractors/discord/test/hook-interact.test.ts`,
`interact.test.ts`); the hub against the demo world's bot (`packages/hub/test/apps.test.ts`, the demo's `Helper` in
libdither's #general: buttons, selects, commands with suggestions and choices, a message command, a form); the page's
state (`packages/web/test/apps.test.ts`); a web build within its budgets. Not checked: any of it against a live
Discord account. The shapes of the client's functions, stores and actions were read from its code, not seen live.
