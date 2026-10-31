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
- **Long-press** (phone): six most-used emoji, the picker as a bottom sheet, Reply, Copy text.
- **A pill**: tap to join or leave. Right-click or long-press to see who reacted; the hub asks the network only if it has not named everyone yet.
- **Picker**: reactions on this message, your frequent ones, custom emoji by source, then all of Unicode with search and skin tones. Enter picks the first result. On Matrix, any text works.

Reactions show immediately and are rolled back with the network's own error if refused ("Missing
Permissions", "User cannot use burst reactions"). Tapping a super pill you can't match adds a normal
reaction instead. Frequent emoji come from what your accounts actually reacted with, on any client.

Discord pushes nothing for server channels that are not open in the client, so the adapter reports
your own reactions itself, and other people's show up when the channel is opened and refetched.
