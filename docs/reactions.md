# Reactions

One model for Discord, Signal and Matrix. A reaction is a **key**, a **style**, a **count** and the
**people we know about**. Adapters report what their network says; the hub stores it; the PWA asks
what is possible here before offering it.

## The model

| Field | Meaning | Why it has to be general |
|---|---|---|
| `key` | Unicode emoji in canonical form, free text, or an opaque native id | Discord custom emoji are `name:id`, Matrix ones are `mxc://…`, Matrix also takes any text |
| `style` | `normal` or `super` | Discord's burst reactions count apart from normal ones, and one person can do both |
| `count` | The network's total | Discord says "40, and you're one of them" without naming the rest |
| `identityIds` | Whoever we know reacted | Signal and Matrix name everyone; Discord only on request |
| `emoji` | Name, image, animated flag, for custom keys | The catalog (`custom_emoji`) fills in as emoji are seen or offered |
| `colors` | Super reactions: colours of the effect | Reported by Discord |

Storage is two tables. `reaction` holds who, `reaction_tally` holds one row per pill in display order.
`reaction_tally.count` is NULL when a network names every reactor, so the number shown is the larger
of the reported total and the people known.

The same emoji arrives spelled differently: Element adds U+FE0F to everything, and a bare `❤` renders
as text. `canonicalReactionKey` reduces them to the fully qualified form at ingest, so they count as
one pill, and each adapter matches on that form when taking a reaction back.

## Rules and context

Two layers decide what you can do.

**Rules** are true of a whole network (`REACTION_RULES`):

| | One per person | Any text | Limit per message |
|---|---|---|---|
| Discord | | | 20 distinct |
| Signal | yes: a new one replaces the old | | |
| Matrix | | yes | |

**Context** depends on the account, conversation and moment (`ReactionContext`, asked of the adapter
when a conversation opens, and cached for two minutes):

| | Discord | Signal | Matrix |
|---|---|---|---|
| `canReact` | Read Message History | still in the group | power level for `m.reaction` |
| `existingOnly` | no Add Reactions: can only join existing ones | | |
| `custom` | the client's own `getEmojiUnavailableReason`, so Nitro, external emoji and animated rules all match Discord | none | MSC2545 image packs: the room's, yours, and ones you enabled |
| `super` | available with Nitro | not a thing | not a thing |

The picker only shows what the context allows. Fancy things appear when they are available and are
not advertised when they are not.

## The flow

- **Hover** (desktop): your three most-used emoji, plus the picker.
- **Long-press** (phone): six most-used emoji, the picker as a bottom sheet, and the rest of the message's actions ([phone.md](phone.md)).
- **A pill**: tap to join or leave. Right-click or long-press to see who reacted; the hub asks the network only if it has not named everyone yet.
- **Picker**: laid out like Discord's. Search and skin tones across the top; a rail of categories down the side
  (your frequent emoji, each server's or pack's custom ones, then Unicode's), which follows the scroll and jumps it;
  sections that fold; and along the bottom the emoji under the pointer by name (and its server), with what picking
  it does here. Reactions already on the message come first, and yours are marked. Enter picks the first search
  result. On Matrix, any text works. On a phone it is a bottom sheet with the rail along the bottom.

**Writing with it.** The composer's smiley button, beside send (in the box on a phone), opens the same picker to put
an emoji into what you are writing, at the caret: Unicode emoji anywhere, and on Discord the custom emoji the
context allows, as Discord's own `<:name:id>` markup (a Matrix pack's go only as reactions, as with `:` completion).
None of the reaction parts show (on this message, super, one per person). A pick closes it; Shift keeps it open for
another. On a phone it is the bottom sheet and the box stays unfocused, so the keyboard stays down.

**Stickers.** Discord stickers arrive as attachments of their own (dither-accounts, `extractors/discord/src/map.ts`):
a PNG or APNG from `cdn.discordapp.com/stickers/{id}.png`, a GIF from the media proxy, and a Lottie animation
(Discord's own stickers) as its JSON, mime `application/x-lottie+json`. A sticker with no words is a message of kind
`sticker` with an empty body, which previews as "Sticker". The timeline draws any sticker at 160 px with no frame
(`ui/Sticker.tsx`); a Lottie one plays through lottie-web's light player (SVG, no expressions), a lazy chunk loaded the
first time one comes on screen, moving only while it is in sight and not at all under reduced motion. Signal and
WhatsApp stickers, also messages of kind `sticker`, get the same look. Sending stickers is not built yet.

**Replacing, not adding.** On Signal and WhatsApp a person keeps one reaction per message, so once you have one,
another replaces it. The add button shows it: arrows where the plus was (`smileSwap`), with the title "Change your
reaction". Your reaction is marked in the hover row and the long-press row, the message menu says "Change Reaction",
and the picker's bottom line says "replaces 👍" for whatever is under the pointer. On Discord and Matrix the button
keeps its plus.

**Drawn whole, without flicker.** Colour emoji fonts draw a glyph about 1.17em tall, so nothing that holds an emoji
clips it vertically (`.emoji-text` clips only sideways, for long Matrix text). The picker lays out every section at
once (sections drawn only as they scrolled in made emoji flash in late), builds its 1,900 buttons once per change of
what it shows, so hovering and scrolling touch only the bottom line and the rail, and the catalog loads when the app
is idle and again as the pointer nears an add button, so even the first picker opens whole.

Reactions show immediately and are rolled back with the network's own error if refused ("Missing
Permissions", "User cannot use burst reactions"). Tapping a super pill you can't match adds a normal
reaction instead. Frequent emoji come from what your accounts actually reacted with, on any client.

Discord pushes nothing for server channels that are not open in the client, so the adapter reports
your own reactions itself, and other people's show up when the channel is opened and refetched.

`scripts/verify-reactions.ts` checks the picker, the drawing and the replacing in headless Chromium against a fresh demo hub.
