# Polls and pins

Polls on Discord and Signal work the same way here. You see the question, the options with a bar and a count each,
your own vote ticked, and whether the poll ended. You can vote, take your vote back, make a poll from the composer,
and end a poll you made. You can pin and unpin a message from its menu, and a place's About lists everything pinned
there. Protocol: `packages/protocol/src/poll.ts`. Hub: `packages/hub/src/polls.ts`. Web: `packages/web/src/polls.ts`,
`ui/Poll.tsx`. The adapters are in dither-accounts (`extractors/discord/src/polls.ts`, `extractors/signal`).

Nothing here has been run against a real account. It was checked against fakes: the hook replica, the fake
signal-cli, the hub's tests and the demo hub.

## A poll

A poll is data on its message: `MessageFact.extra.poll` (`PollFact`). It has the question, the options (each with
the network's id: Discord's answer id, or Signal's position as a string), whether more than one option may be
chosen, when voting closes (Discord), the counts and your own options when the network gave them, and whether it
ended. The adapter also puts the question and options in the body, for search, previews and old hubs. When the
message shows as a poll card, that body text is hidden.

Votes come as `pollUpdate` events (capability `polls`). An update can carry any of these:

| Part | Means | From |
|---|---|---|
| `counts` | votes per option, replacing what the hub had | Discord, when its client has the poll loaded |
| `add` | votes added or taken away per option | Discord, when its client does not have the poll loaded |
| `mine` alone | your own vote is now these options, and the hub moves the counts by what changed | a vote you just made on Discord |
| `vote` | one voter's whole vote with its number; the hub keeps the highest number per voter, as Signal's apps do | Signal |
| `ended` | the poll is closed | both: Signal's `pollTerminate`, Discord's poll result message, or ending it from here |

The hub keeps what changed in two tables, created when first used:

- `poll_state`: the counts, your options, the number of voters, and whether the poll ended.
- `poll_vote`: one row per voter on Signal.

A message fact that brings its own counts (Discord sends the message again with them) is newer than `poll_state`,
so it clears the counts kept there. `MessageView.poll` (`PollView`) is what the web shows. A poll whose time has
passed counts as ended. `seq` is your last vote's number, which the next Signal vote has to beat.

### Who voted

A network shows everyone who voted for what only on Signal, so names are kept only there. `PollOptionView.voters`
lists the voters' identities, and the card names them under each option. Discord shows voters only when someone
clicks a count, and its client asks Discord for them then. dither-chat never makes that request, so Discord polls
show counts only.

### Voting, making, ending

- `POST /api/messages/:id/vote { options }`, where `[]` takes your vote back. It needs an account with `pollVote`.
  The hub first checks the vote against the poll's rule (`pollVoteProblem`: one choice unless the poll allows
  more, only its own options, not once it ended). An open message request is refused with "Accept this message
  request first", because a vote would answer it.
- `POST /api/conversations/:id/polls { question, options, multi, hours? }` (capability `pollCreate`) is checked
  against `POLL_RULES` and `pollDraftProblem`:
  - Discord: 2 to 10 options, a question of up to 300 characters, options of up to 55, open for 1, 4 or 8 hours,
    1 or 3 days, or 1 week (1 day when none is chosen).
  - Signal: 2 to 10 options, no timer.

  It is refused in an open message request too.
- `POST /api/messages/:id/end-poll` (capability `pollEnd`) works only for your own poll, through the account that
  made it.

The card on phone and desktop: where the network lets a vote change later (`PollRules.voteChangeable`: Discord and
Signal), a tap votes at once, as their own apps do. On a one-choice poll a tap on another option moves your vote and
a tap on your own takes it back; on a several-choice poll each tap adds or takes away that option. Where a vote could
not be changed, you pick, then press **Vote**, and the vote is final: the options lock and nothing offers to take it
back. **End poll** appears only on a poll you made. Counts show once you have voted, once the poll has ended, or when
no account here can vote. A poll can also be ended from the message menu (**End Poll**).

### Making one

**Poll** in the + menu on a computer ([sending.md](sending.md) "The box on a computer"), or in the + sheet on a phone,
turns the message box into the poll's draft, shaped like the poll it becomes (`PollMaker` in `ui/Poll.tsx`). Its header
names the network and its limits ("2 to 10 options"). What the box held becomes the question, its lines joined. An
option row is added as the last is used, up to the network's most; the marks are round for one choice and square for
several. The pills choose **One choice** or **Several**, and on Discord how long it stays **Open** (Signal has no
timer, so no pill). Enter goes to the next line, and from the last one (or with Ctrl) sends; Esc, or the ×, goes back
to the message box with its text. Once sent the box comes back empty. The card and the draft are a lazy chunk
(`ui/PollLazy.tsx`); until it loads, a poll message shows its text.

## Pins

`configure` with `{ key: 'pin', message, remove?, seconds? }` (capability `pin`). `seconds` is how long the pin
lasts, one of `PIN_DURATIONS` for the network (Signal: 1 day, 1 week, 30 days, or until unpinned; the first is the
default). Discord pins have no timer.

- Message menu: **Pin Message** (on Signal, a submenu of how long) or **Unpin Message**. It shows wherever an
  account that sees the message has `pin`. The pin then goes through the conversation's About route, so the About's
  `pinned.canEdit` decides, as it does for **Unpin** in the About.
- About: the pinned list. When an adapter's list is not `complete` (Signal keeps none that a linked device can
  read), the hub adds the pins it saw itself: messages whose latest pin or unpin event is a pin (`pinnedSeen`).
  Those events are kept only while change history is on (docs/history.md). Discord's list is read from Discord
  whenever the About is opened (kept a minute), so it is whole.

Who may pin:

- Discord: anyone in a DM or group DM; elsewhere, Pin Messages or Manage Messages.
- Signal: whoever may send in the group, and either person in a 1:1. Signal's own rule for groups is not written
  down anywhere this repo could check.
