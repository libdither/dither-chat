# What a message carries besides its text

A network says more about a message than its body and files: what it quotes, a contact card, that it answers a story,
who it did not reach. Adapters put that in `MessageFact.extra` under the keys `packages/protocol/src/extra.ts` names
(`MessageExtra`). The hub keeps `extra` as it came (`message.extra`) and draws the known keys into `MessageView`
(`packages/hub/src/msgextra.ts`); the timeline shows them (`packages/web/src/ui/MessageExtras.tsx`). Every key is
optional, a hub that does not know a key keeps it and shows nothing of it, and an adapter sets only what its network
has. Signal (dither-accounts, `extractors/signal`) fills all of them today.

| `extra` key | Shown as | Where it comes from on Signal |
|---|---|---|
| `quote` | The reply's quote line, from the reply itself, when the quoted message is not on the hub (anything from before a linked device was linked). A stored message wins: the hub leaves `quote` out of the view then. Its author, text, a word for its files ("Photo"), and a thumbnail when the network sent one | `dataMessage.quote` (`text`, `mentions`, `textStyles`, `attachments[].thumbnail`) |
| `embeds` | Link previews, as Discord's embeds already were: title, description, site, picture | `dataMessage.previews[]` (`url, title, description, image`); the picture only when it downloaded |
| `contacts` | A card per shared contact: name, organisation, numbers and emails (tap to call or write), addresses; **Message** when someone the hub knows has that number or email, else **Message** opens New message with the number where an account can start one. The body keeps one line per card for search, previews and older clients (`line`); the card replaces it on screen | `dataMessage.contacts[]` (`name, phone, email, address, organization, avatar`) |
| `storyReply` | "Replied to your story" or "Reacted ❤️ to your story" above the text (or "Alice's story", "a story"). Stories themselves are not shown | `dataMessage.storyContext`, and a reaction with one |
| `failed` | Under your message: "Not delivered to Sam (no longer on Signal)". Only when it reached the others: when nobody gets it, the send fails as before and the composer says so | `send`'s `results[].type` (`UNREGISTERED_FAILURE`, `IDENTITY_FAILURE`, `RATE_LIMIT_FAILURE`, `NETWORK_FAILURE`, `INVALID_PRE_KEY_FAILURE`) |
| `missingAttachments` | "Attachment not downloaded: send.mp4 (4.8 MB)" instead of the file vanishing | an attachment with no `id`, or whose file is not on disk when signal-cli hands the message over (it downloads first) |
| `attachmentNotes` | A voice note's "Voice message" label, and a file's own caption, under it (by position in `attachments`) | `attachments[].isVoiceNote`, `attachments[].caption` |
| `sourceDevice`, `serverReceivedTs`, `serverDeliveredTs` | Kept, not shown yet | the envelope |

Not built here: resending to only the people a group message missed. Signal's apps do it by sending again with the
same timestamp to those people; signal-cli 0.14.8 has no way to send a group message to some of its members, so the
line says to send it again if they should have it.

## Messages that could not be decrypted

When signal-cli cannot decrypt someone's message (its `receive` notification carries an `exception` and nothing
readable), a system line goes in your 1:1 with them, as Signal's own apps put it: "A message from Sam could not be
decrypted." Nothing of its content (there is none), once per message, and nothing is asked of anyone: signal-cli's own
retry request, when it makes one, stays its business. A duplicate or one of your own sends coming back is not a lost
message and makes no line. The line has an id of its own (`<author>:<ts>:undecrypted`), so the message arriving again
decrypted shows as itself beside it. If messages from someone keep failing, **Reset secure session** on the 1:1's About
starts their encryption session again (Signal's end session, capability `resetSession`, `POST
/api/conversations/:id/reset-session`); it tells them, so it asks first, and is refused in a message request.

## Viewed receipts

Playing someone's voice note or video (the player's `play`) asks the hub to tell them, once per message: `POST
/api/messages/:id/viewed`, then the `viewed` command to an account with the `viewed` capability. On Signal that is
`sendReceipt --type viewed` ("Played" on their phone). The adapter sends none for your own messages, in a message
request (the quiet rule: dither-accounts docs/signal.md), or unless your phone's read receipts are on (see below).

## Link previews you send

An account with the `linkPreviews` capability gets a preview with what you send: the hub fetches the first link in
the text (`packages/hub/src/unfurl.ts`) and passes `send`'s `preview` (`url, title, description?, image?`), the way
Signal's apps make one on the sender's device. The fetch keeps the media proxy's rules (`fetchsafe.ts`): public
addresses only, every redirect checked again, no credentials in the URL, at most 512 KB of the page (HTML only) and 1 MB
of its picture (JPEG, PNG, WebP or GIF), five seconds each. A page without a title, or anything that goes wrong, is no
preview, never a failed send. The picture is a file in `<data>/previews` for the length of the send. Messages with
files carry none, as on Signal.

Signal's adapter offers `linkPreviews` only while your phone's link-preview setting is on, so the hub fetches nothing
for an account whose owner turned previews off; the adapter checks again when it sends, and leaves out a preview whose
link is not in the text (signal-cli's rule). The site sees the hub fetch the page, as it would see your phone.

## Your phone's settings (Signal)

signal-cli keeps the settings your phone syncs (Settings → Privacy, Chats) in its account database, and no JSON-RPC
method reads them. The adapter reads three, read-only, from `<signal-cli>/data/<path>.d/account.db` (`key_value`:
`config-read-receipts`, `config-typing-indicators`, `config-link-previews`), at most once a minute and at each
snapshot. A setting the phone has not synced, or a database a newer signal-cli laid out differently, counts as not
known, and each use says what it does then:

| Setting | Off on the phone | Not known |
|---|---|---|
| Typing indicators | your typing is not sent | sent, as before (Signal's default is on; the hub's own "Show others when I'm typing" still applies) |
| Read receipts | no viewed receipts (signal-cli already keeps read receipts to your own devices) | no viewed receipts |
| Link previews | no previews, and the hub is not offered them | no previews |
