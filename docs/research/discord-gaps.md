# Discord web client vs dither-chat's Discord adapter: gaps

Read-only research, 2026-11-12. Source of "what Discord can do": the JS bundles cached in the throwaway account's profile (latest web build 671535), mined for Flux action types, the REST `Endpoints` map, and enums. Source of "what dither does": `dither-accounts/extractors/discord/src` (hook.js, main.ts, map.ts, ingest.ts, about.ts, add.ts, profile.ts, search.ts), `dither-chat/packages/protocol/src`, and a keyword pass over `packages/hub` and `packages/web`. Only JS was extracted; no API responses were read.

**Classes.** (a) not ingested at all. (b) read/ingested, but no write or action. (c) in the adapter/protocol, but no hub/UI. (d) partial.
**Value** is for a personal multi-network client: H/M/L.
**Risk** describes what doing it would add on top of today's baseline, which already drives the real client. *client-path* means calling the client's own module, as a click would. That adds little risk. *odd-traffic* means requests a human rarely makes in that pattern, which a pacer must hold to human rates. *no* means don't build it: it is scraping, or it is against the user's decision on active member scraping.

## Discord client facts

- **Builds cached:** 9 web entry bundles, build numbers 655747 to 671535 (newest `web.637e82960de4dc33.js`, 12.6 MB). Plus 4,017 lazy chunks. 4,389 JS cache entries were extracted, 4,026 of them unique files. The bundle has no build timestamp, only `buildNumber`. The mining used the newest web bundle and every chunk.
- **Flux action types:** 2,260 distinct `type:"…"` literals were dispatched. With handler-map keys and `subscribe("…")` the count is about 3,366 (noisy).
- **REST endpoints:** 1,041 keys in the Endpoints map. About 160 are billing/store/quests/ads/collectibles/family center/dev portal, which are irrelevant here.
- **Gateway opcodes (32):** DISPATCH 0, HEARTBEAT 1, IDENTIFY 2, PRESENCE_UPDATE 3, VOICE_STATE_UPDATE 4, VOICE_SERVER_PING 5, RESUME 6, RECONNECT 7, REQUEST_GUILD_MEMBERS 8, INVALID_SESSION 9, HELLO 10, HEARTBEAT_ACK 11, CALL_CONNECT 13, GUILD_SUBSCRIPTIONS 14, STREAM_CREATE 18, STREAM_DELETE 19, STREAM_WATCH 20, STREAM_PING 21, STREAM_SET_PAUSED 22, REQUEST_GUILD_APPLICATION_COMMANDS 24, REQUEST_FORUM_UNREADS 28, REMOTE_COMMAND 29, GET_DELETED_ENTITY_IDS_NOT_MATCHING_HASH 30, REQUEST_SOUNDBOARD_SOUNDS 31, REQUEST_LAST_MESSAGES 34, SEARCH_RECENT_MEMBERS 35, GUILD_SUBSCRIPTIONS_BULK 37, GUILD_CHANNELS_RESYNC 38, REQUEST_CHANNEL_MEMBER_COUNT 39, QOS_HEARTBEAT 40, UPDATE_TIME_SPENT_SESSION_ID 41, REQUEST_CHANNEL_INFO 43.
- **Message types:** 0 to 56 (55 values). Newer ones include POLL_RESULT 46, VOICE_HANGOUT_INVITE 45, GUILD_JOIN_REQUEST_* 52 to 54, HD_STREAMING_UPGRADED 55 and CHAT_WALLPAPER_SET 56. map.ts names 0 to 24 and 46, so 25 to 56 (except 46) fall to a generic rendering.
- **Channel types:** 0 to 21, including LOBBY 17, DM_SDK 18, MEDIA_THREAD 19, GUILD_SPACE 20 and GUILD_APP 21. map.ts handles 0 to 5 and 10 to 16.
- **Component types:** 1 to 23. ACTION_ROW, BUTTON, the selects, TEXT_INPUT, then Components V2: SECTION 9, TEXT_DISPLAY 10, THUMBNAIL 11, MEDIA_GALLERY 12, FILE 13, SEPARATOR 14, CONTAINER 17, LABEL 18, FILE_UPLOAD 19, CHECKPOINT_CARD 20, RADIO_GROUP 21, CHECKBOX_GROUP 22, CHECKBOX 23.
- **Message flags:** CROSSPOSTED 1, IS_CROSSPOST 2, SUPPRESS_EMBEDS 4, SOURCE_MESSAGE_DELETED 8, URGENT 16, HAS_THREAD 32, EPHEMERAL 64, LOADING 128, SUPPRESS_NOTIFICATIONS 4096, IS_VOICE_MESSAGE 8192, HAS_SNAPSHOT 16384, IS_COMPONENTS_V2 32768, HIDDEN_SUSPENDED_USER 131072, IS_GUILD_OFFICIAL 524288. Attachment flags: IS_CLIP, IS_THUMBNAIL, IS_REMIX, IS_SPOILER, CONTAINS_EXPLICIT_MEDIA, IS_ANIMATED.
- **Named experiments seen:** 22 (most are hashed or unnamed). Ones that look like product features: `2026-06_guild_rooms`, `2026-04_server_theme`, `2026-03_guild_official_messages`, `2026-02_hangout_window`, `2026-02_past_vc_activity_messages`, `2025-12_voice_channel_hoisting`, `2026-04_voice_user_duration`, `2022-07_voice_in_threads`.
- **What the hook uses today:**
  - **Actions:** it subscribes to 35 action types plus CONNECTION_OPEN: MESSAGE_CREATE/UPDATE/DELETE, the 4 reaction events, CHANNEL_CREATE/UPDATES/DELETE, GUILD_CREATE/UPDATE/DELETE, THREAD_CREATE/UPDATE/DELETE/LIST_SYNC, MESSAGE_ACK, TYPING_START, CHANNEL_PINS_UPDATE, GUILD_MEMBER_UPDATE, PRESENCE_UPDATE(S), CONNECTION_OPEN_SUPPLEMENTAL, GUILD_MEMBERS_CHUNK(_BATCH), GUILD_MEMBER_LIST_UPDATE, RELATIONSHIP_ADD/UPDATE/REMOVE, LOAD_RELATIONSHIPS_SUCCESS, UPDATE_STRANGER_STATUS, CHANNEL_RECIPIENT_ADD/REMOVE. It also dispatches or intercepts TYPING_START/STOP_LOCAL, GUILD_MEMBERS_REQUEST, GUILD_SEARCH_RECENT_MEMBERS and VOICE_SERVER_UPDATE (the direct-mode intercept).
  - **REST and client modules:** about 20 of the 1,041 endpoints, called directly or through client modules: MESSAGES, MESSAGE (patch/del), MESSAGE_ACK, REACTION(S), message search (channel/guild), THREAD_SEARCH, MESSAGE_CREATE_ATTACHMENT_UPLOAD, ATTACHMENTS_REFRESH_URLS, USER_CHANNELS, CHANNEL_RECIPIENT, CHANNEL (patch), GUILD (patch name), USER_PROFILE, `/users/@me/profile` (bio), invite resolve/accept, and the relationship endpoints through RelationshipActions. Typing goes through TypingActions. Voice uses op 4 through VoiceActions; members use op 8 through MemberActions.
  - **Modules found:** 40 FINDERS: stores, Rest, MessageActions, PrivateChannelActions, VoiceActions/AudioActions, InviteActions, RelationshipActions, MemberActions, ProfileFetch, and others.
- **A generic `rest(verb, url, …)` helper exists in hook.js.** Most of the b/c gaps below are one hook command plus one protocol command. The hard part is protocol/UI design, not reaching Discord.

## Messages: reading

| Feature | Discord has (evidence) | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Message components (buttons, selects) | component types 1–8; INTERACTION_CREATE/SUCCESS/FAILURE, `INTERACTIONS` | `pickMessage` drops `components` | a | M | Bot messages show their text but none of their buttons. **done** (net-gaps): kept as rows with their custom ids and shown read-only; link buttons open (rich-messages.md). Pressing is a later `interact` |
| Components V2 messages | flag IS_COMPONENTS_V2, types 9–23 (TEXT_DISPLAY, CONTAINER, MEDIA_GALLERY…) | dropped | a | H | Such messages have empty `content` and no embeds, so they arrive **blank**. More bots send them every month. At least flatten TEXT_DISPLAY and MEDIA_GALLERY into body and attachments. **done** (net-gaps): flattened into body and attachments, controls kept |
| Message flags in general | MessageFlags enum above | `flags` not picked | a | M | Several rows below follow from this. **done** (net-gaps) |
| Silent messages (@silent) | SUPPRESS_NOTIFICATIONS 4096 | not seen | a | M | dither may alert on something the sender marked silent. A cheap triage input. **done** (net-gaps): `MessageFact.silent`; triage never alerts on it |
| Voice messages | IS_VOICE_MESSAGE 8192, attachment `duration_secs`/`waveform`, RECORD_VOICE_MESSAGE | shown as a plain audio file | d | M | Gets no waveform, no duration and no "voice message" kind (the hub has a `played` receipt concept from Signal). **done** (net-gaps): length and waveform kept, a player with the waveform |
| Ephemeral / "only you can see" | EPHEMERAL 64 | not marked | a | L | Ephemerals come only by the live gateway, so they are rare in dither. **done** (net-gaps): marked "Only you" |
| Crossposts (announcement follows) | IS_CROSSPOST 2, CROSSPOSTED 1, `message_reference` type 0 + webhook | shown as a webhook message | d | L | Gets no "from #channel in Server" header. **done** (net-gaps): "from #channel in Server", from the webhook's name |
| Embeds, full | embed color, footer, timestamp, video, author icon, provider url | picks type/title/description/url/provider/author name/fields/thumbnail/image | d | M | No video embeds (YouTube/Twitch play inline in Discord), no color bar, no footer. **done** (net-gaps): colour bar, footer and time, author icon; YouTube/Twitch/Vimeo players load only when clicked |
| SUPPRESS_EMBEDS | flag 4 | not seen | a | L | dither may show a preview the author hid. **done** (net-gaps): no embeds shown |
| Attachment alt text | attachment `description` | not picked | a | M | Accessibility; also searchable text. **done** (net-gaps): shown, and searched (found when no message text matches) |
| Spoilered attachments | IS_SPOILER / `SPOILER_` filename | not picked | d | M | `\|\|text\|\|` spoilers render, but spoilered images show unblurred. **done** (net-gaps): blurred until clicked |
| Explicit-media flags | CONTAINS_EXPLICIT_MEDIA, EXPLICIT_MEDIA_SCAN_* | not picked | a | L | Discord blurs these. dither shows them raw. **done** (net-gaps): CONTAINS_EXPLICIT_MEDIA blurred as a spoiler; the EXPLICIT_MEDIA_SCAN_* settings are not read |
| Stickers | `sticker_items`, STICKER, STICKER_ASSET, STICKER_PACKS, MESSAGES_GREET | body becomes `[sticker: name]`; no image | d | M | The sticker CDN url comes from id + format_type; Lottie needs a player. **done** (#123): checked in net-gaps, nothing missing for reading |
| Polls, results | `poll` object (answers, counts, expiry, multiselect), MESSAGE_POLL_VOTE_ADD, POLL_RESULT type 46 | question + answer texts as markdown; result as a system line | d | M | No counts, no expiry, no "you voted" **done** (net-gaps): the poll as data on its message (counts, expiry, your vote), votes as they come, POLL_RESULT closes its poll; voters never asked for ([polls.md](../polls.md)) |
| Poll voting | POLL_ANSWERS (put/del `/polls/{id}/answers/@me`) | none | a | M | client-path: one request, like a click **done** (net-gaps): the client's poll actions (its REST helper when that chunk is not loaded) |
| Poll create / end early | CREATE_POLL, POLL_EXPIRE | none | a | L | ROADMAP lists "polls" as later **done** (net-gaps): its own sendPollMessage, with the durations its dialog offers; End Now through its poll actions |
| Timestamp tags `<t:…:R>` | markdown rule | rendered as raw `<t:1731…:R>` | a | M | Easy win in web/src/markdown.ts. **done** (net-gaps): every style, relative ones moving on |
| Markdown: masked links, headings, lists, subtext | client markdown rules | headings→bold, `-#`→small, lists, quotes, custom emoji | d | L | Numbered lists, nested lists and code highlighting look unchecked. **done** (net-gaps): numbered and nested lists; masked links checked. Code highlighting **not built**: a fence keeps its language only |
| Role mentions | `mention_roles`, `<@&id>` | `mention_roles` not picked; `mentionsSelf` = by name or @everyone | a | H | A ping to a role you hold does not count as a mention, which matters for triage. Needs your roles (GuildMemberStore, self only). **done** (net-gaps): your roles from the snapshot and your own member updates; a ping to one is `mentionsSelf` |
| Channel/role mention rendering | `<#id>`, `<@&id>`, `<id:guide>`, `<id:customize>` | `<#id>` rendered; role mentions likely raw | d | L | **done** (net-gaps) |
| Interaction metadata ("X used /cmd") | `interaction_metadata`, MESSAGE_INTERACTION_DATA, LOAD_MESSAGE_INTERACTION_DATA_SUCCESS | type 20/23 treated as plain | d | L | Who ran the command is lost. **done** (net-gaps) |
| New system message types 25–56 | MessageType enum (STAGE_*, POLL_RESULT handled; GUILD_JOIN_REQUEST_*, VOICE_HANGOUT_INVITE, PURCHASE_NOTIFICATION, CHAT_WALLPAPER_SET…) | fall back to generic | d | L | Add sentences for stage start/end/topic, hangout invite and join-request outcomes. **done** (net-gaps): 13–17, 22, 25–41, 45, 64, 66 and the notices have words |
| DM call messages | type 3 CALL with `call.ended_timestamp`/participants | system line | d | M | ROADMAP's "calls without media" wants missed/answered calls and duration **done** (net-gaps): "📞 Missed call", "📞 Call, 12 min with …" from call.participants and ended_timestamp |
| Activity invites in messages | `activity`, `application` on message; VOICE_HANGOUT_INVITE | not picked | a | L | **done** (net-gaps): a line under the message; answering is on Discord |
| Message link previews (jump to Discord message) | message links unfurl to a quoted preview in the client | link stays a link | a | L | **done** (net-gaps): a stored message shows as a quote; nothing is fetched |
| Guild "official" messages | IS_GUILD_OFFICIAL, GUILD_OFFICIAL_MESSAGES, exp `2026-03_guild_official_messages` | not marked | a | L | **done** (net-gaps) |
| Hidden suspended user | HIDDEN_SUSPENDED_USER | not marked | a | L | **done** (net-gaps) |
| Edits pushed while idle in unopened guild channels | MESSAGE_UPDATE only for subscribed channels | blocked, as ROADMAP says | d | H | Known limit. Opcode REQUEST_LAST_MESSAGES 34 and `MESSAGE_PREVIEWS` (`/channels/preload-messages`) are what the client uses to preview many channels at once. A possible lever, but odd-traffic. **not built**: odd traffic (net-gaps) |
| Bulk deletes | MESSAGE_DELETE_BULK | not subscribed | a | M | Mod purges leave ghosts in dither. **done** (net-gaps) |
| AutoMod-blocked/flagged content | AUTO_MODERATION_ACTION type 24, MESSAGE_EDIT_FAILED_AUTOMOD, AUTO_MODERATION_CONTENT_DELETED | system line only | d | L | Your own send blocked by AutoMod should come back as an error, and may not. **done** (net-gaps): a send or edit AutoMod blocks comes back as "This server's AutoMod blocked it: …" |
| Super-reaction details | `burst_colors`, `count_details`, BURST_REACTION_EFFECT_PLAY | done (style super, colors) | – | – | Not a gap |
| Reactions added many at once | MESSAGE_REACTION_ADD_MANY | not subscribed | a | L | Batched form some builds use; reactions could be missed. **done** (net-gaps): poll votes that come this way are left to polls |

## Messages: writing and actions

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Pin / unpin a message | PIN (`/channels/{c}/messages/pins/{m}` put/del) | read (pin events, PlaceProfile pinned list, Unpin button); about.ts throws "Pinning is not supported on Discord yet" | b | M | Protocol `AboutChange {key:'pin'}` and UI exist; only the adapter refuses. client-path **done** (net-gaps): the pin button's request through the client's REST helper (its pinMessage turns a refusal into a dialog in the page) |
| Pinned list fetch | PINS (`/messages/pins`), PINS_ACK | pins seen only as they happen or via loaded messages | d | M | A channel's existing pins are unknown until messages load **done** (net-gaps): read when the About is opened, the popout's pages (up to 100), then acked as the popout does |
| Mark unread | MESSAGE_ACK with `manual: true` | markRead only | a | M | Hub has "Later" but cannot push an unread state back to Discord **done** (net-gaps): Mark Unread in the message menu (hub `unread.ts`) sends a manual ack; one made in Discord comes back as `read` with `manual` and moves the hub's read point back |
| Bulk ack | BULK_ACK (`/read-states/ack-bulk`) | markRead one channel at a time | d | L | The hub's paced mark-all queue could use one request **done** (net-gaps): the read queue sends up to 50 per request (`markReadMany`) through the client's BULK_ACK |
| Read-state sync for non-channel things (forum unread, guild events, profile) | USER_NON_CHANNEL_ACK, PROFILE_READ_STATE, FORUM_UNREADS | none | a | L | **not built**: L, and no forum unreads, event or profile read state in the hub to sync |
| Saved messages / bookmarks | GET_SAVED_MESSAGES, PUT/DELETE_SAVED_MESSAGE, GET_BOOKMARKS, SAVED_MESSAGE_CREATE/DELETE, SAVED_MESSAGES_UPDATE | none | a | M | Pull them in as hub-side "kept"/marks; two-way sync is cheap. client-path |
| Reminders ("Remind me") | MESSAGE_REMINDER_DUE, saved-messages `due_at` | none (hub has its own Later) | a | M | Could map onto dither's Later both ways |
| Scheduled messages | SCHEDULED_MESSAGES (+ _SEND, _UPDATE, _DELETE), SCHEDULED_MESSAGE_DRAFT_CHANGE | none | a | M | Send later, natively (survives the hub being down). A hub-side send-later would work on every network |
| Send voice message | RECORD_VOICE_MESSAGE, IS_VOICE_MESSAGE upload with waveform | files only | a | L | |
| Send stickers | STICKER_PACKS, `sticker_ids` on send | none | a | L | ROADMAP: later |
| GIF picker | GIFS_SEARCH/TRENDING/SUGGEST (Tenor/Klipy) | none | a | L | Pasting a link already works |
| Silent send (@silent) | SUPPRESS_NOTIFICATIONS on send | none | a | L | One flag in the send payload |
| Reply without ping | `allowed_mentions.replied_user` (SET_PENDING_REPLY_SHOULD_MENTION) | hook sends `messageReference` only, so every reply pings | d | M | A toggle in the composer; one field in sendMessage options |
| Suppress embeds on own message | MESSAGE patch flags 4 | none | a | L | |
| Publish (crosspost) in announcement channel | MESSAGE_CROSSPOST | none | a | L | **done** (net-gaps): Publish on your own message, after a confirm; a published one is marked |
| Create thread from message / in channel | CHANNEL_MESSAGE_THREADS, CHANNEL_THREADS (post) | reads threads only | b | M | **done** (net-gaps): Create Thread on a message, Start Thread in a channel, private ones too |
| Create forum post (title + tags) | CHANNEL_THREADS with `applied_tags`, FORUM_TAGS | none | a | M | Forums are read-only in dither **done** (net-gaps): title, message, tags, files |
| Join / leave a thread; thread notification setting | THREAD_MEMBER_SETTINGS, THREAD_MEMBERS_UPDATE, THREAD_MEMBER_UPDATE | not subscribed | a | M | Discord only notifies for joined threads; dither cannot follow one **done** (net-gaps): follow and unfollow, all/mentions/nothing and a mute; membership reaches triage as the thread's native mute |
| Archive/lock/rename thread | CHANNEL patch `archived`/`locked` | configure does name/topic/slowmode/nsfw on channels | d | L | **done** (net-gaps): archive, unarchive, lock, unlock where a fresh About says so; rename as before |
| Slash commands (bot apps) | APPLICATION_COMMAND_INDEX_CHANNEL/GUILD/USER, INTERACTIONS, opcode 24, APPLICATION_COMMAND_AUTOCOMPLETE_* | none; body `/foo` is sent as text | a | M | Big for bot-heavy servers. client-path via the client's own command executor; ToS-neutral as it is a user action |
| Click a button / pick a select | INTERACTIONS (type 3), QUEUE_INTERACTION_COMPONENT_STATE | none | a | M | Needs components ingested first |
| Modals from bots | INTERACTION_MODAL_CREATE, TEXT_INPUT, LABEL, FILE_UPLOAD | none | a | L | |
| User-installed apps / context-menu commands | APPLICATION_COMMAND_INDEX_USER, type 23 | none | a | L | |
| Report a message/user | REPORT_V2, GET_REPORT_MENU, SUBMIT_REPORT_MENU | none | a | L | Linking out to Discord is enough |
| AI: translate, summarize thread, fix grammar, title | AI_TRANSLATE, AI_SUMMARIZE_THREAD, AI_FIX_GRAMMAR, AI_TEXT_TRANSFORM, AI_TITLE | none | a | L | The hub has local models; Discord's are gated and server-side |
| Channel summaries ("conversations") | CHANNEL_SUMMARIES, CHANNEL_CONVERSATIONS (+ _MESSAGES), CONVERSATION_SUMMARY_UPDATE, RECEIVE_CHANNEL_SUMMARIES_BULK | none | a | M | Discord's own topic clustering of busy channels; could seed dither's catch-up for big servers. Gated per guild |
| Message edit while the hub thinks an older body | – | hub keeps edit log (message_event 'edit') | – | – | Not a gap |
| Delete someone else's message (moderator) | MESSAGE del with MANAGE_MESSAGES | redact is own messages in UI? | d | L | Check whether the UI offers delete when the About says moderator |
| Remove all reactions / one emoji (mod) | REMOVE_REACTIONS, REMOVE_EMOJI_REACTIONS | read only | b | L | |
| Remove someone else's reaction (mod) | REACTION with user id | none | a | L | |

## Mentions, inbox, notifications

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Recent mentions inbox | MENTIONS (`/users/@me/mentions`), LOAD_RECENT_MENTIONS(_SUCCESS), RECENT_MENTION_DELETE | none; dither sees mentions only in messages it ingested | a | H | The one place to learn about mentions in unopened guild channels while idle (the "blocked" ROADMAP row). Polling it at human rates is client-path **done** (net-gaps): asked through the client's RecentMentionsActions (REST fallback) after a snapshot and on a notification-center mention, at most every 5 min; hits are `late` message facts, triaged as live only under 10 min old (LATE_NEWS_MS) |
| Notification center ("For You": friend accepted, reactions, mentions, event reminders) | NOTIF_CENTER_ITEMS (+ _ACK, _BULK_ACK), NOTIFICATION_CENTER_ITEM_CREATE/DELETE/COMPLETED | none | a | M | Gateway pushes NOTIFICATION_CENTER_ITEM_CREATE live: a cheap subscribe for "someone reacted to your message" **done** (net-gaps), passive: mention items are late mentions (or ask the list), REACTION_NOTIFICATION_SENT is a reaction fact on your message; friend accepted comes as relationships already; event reminders, ack and bulk-ack **not built** (no Discord events surface in the hub yet) |
| ICYMI / guild feed / highlights | ICYMI, GUILD_FEED, LOAD_ICYMI_*, DISABLE_SERVER_HIGHLIGHT_NOTIFICATIONS | none | a | L | Discord's own ranking; dither has its own **not built**: Discord's own ranking; dither ranks its inbox itself |
| Per-guild/channel notification level (all/mentions/none, suppress @everyone/roles, mobile push) | USER_GUILD_SETTINGS(_BULK), USER_GUILD_SETTINGS_* actions | mute + level read once at snapshot; no live updates; no write | b | M | Changes made in Discord after start are missed until restart (USER_GUILD_SETTINGS_* not forwarded). Writing would sync dither's mute back **done** (net-gaps): USER_GUILD_SETTINGS_* and the mute expiries forwarded, the changed places' facts again (`{}` clears); suppress @everyone/roles read into NativeMute (suppressEveryone lowers triage's would-notify); writing levels other than mute **not built** |
| Mute channel/guild/DM with a timer | USER_GUILD_SETTINGS patch `mute_config`, CHANNEL_MUTE_EXPIRED | read only | b | M | Hiding in dither does not mute on Discord, so phone Discord still buzzes **done** (net-gaps): "Mute on Discord…" with Discord's timers on a place's About, through NotificationSettingsActions; dither's own Mute unchanged and separate; CHANNEL_MUTE_EXPIRED/GUILD_MUTE_EXPIRED handled |
| Thread notification settings | THREAD_MEMBER_SETTINGS | none | a | L | **not built**: L; thread member flags live in a store the hook does not read, and active threads are not in the snapshot **done** (net-gaps, discord-threads): see Join / leave a thread above |
| Account-wide notification settings | ACCOUNT_NOTIFICATION_SETTINGS, …_DECLARATIVE_SETTINGS | none | a | L | **not built**: no hub surface for them; dither's own rules and quiet hours decide |
| Message requests (DMs from non-friends) | MESSAGE_REQUESTS, MESSAGE_REQUEST_ACCEPT_OPTIMISTIC, CHANNEL_RECIPIENT_REJECT_BATCH, channel `is_message_request` | not distinguished; a request DM looks like any DM | a | H | dither may alert on strangers Discord itself hides. The hub already has a requests inbox (add.md) that could hold them; accept/reject is client-path **done** (net-gaps): `is_message_request` DMs are `message` RequestFacts (`message:<channel>`), held silent under Requests; Accept (consent_status 2), Decline (batch-reject) and Block through the client's request module or its REST helper |
| Spam-filtered DMs | channel `is_spam`, `2021-12_inferno_spam_redaction` | not distinguished | a | M | Same as above **done** (net-gaps): `is_spam` DMs are message requests with `spam`: never notified, last under Requests, off the Requests row's count |
| Safety warnings in DMs | ADD_SAFETY_WARNING, CHANNEL_SAFETY_WARNINGS_ACK, DELETE_SAFETY_WARNINGS | none | a | L | **not built**: L; needs the DM's `safety_warnings` picked, a ConversationFact field and a web banner line |
| Unread counts per channel from Discord's read states | ReadStateStore (mention_count, last_message_id) | snapshot + MESSAGE_ACK | d | M | Live CHANNEL_UNREAD_UPDATE is not forwarded **partly done** (net-gaps): MESSAGE_ACK now reads the gateway's `newMentionCount` and `manual`; CHANNEL_UNREAD_UPDATE (last message ids, not read points) **not built**: it says nothing the messages do not |

## Threads, forums, channels

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Forum tags on posts | FORUM_TAGS, `applied_tags`, `available_tags` | not picked | a | M | Filters and labels in a forum view **done** (net-gaps): a forum's tags and each post's, as chips, filter by tag, tags on a new post (threads.md) |
| Forum post list with previews / sort | FORUM_POSTS (`/post-data`), LOAD_FORUM_POSTS, FORUM_SEARCH_* | threads listed (`threads` command), no first-message preview | d | M | **done** (net-gaps): each post's first message from Discord's thread search (and LOAD_FORUM_POSTS when the client loads them), latest activity or newest first (threads.md) |
| Forum unread state | REQUEST_FORUM_UNREADS op 28, FORUM_UNREADS | none | a | L | **not built**: FORUM_UNREADS comes only when the client's own forum view asks, which the sandbox never shows; the hub's own per-post unread counts stand in |
| Media channels (type 16) | GUILD_MEDIA | mapped | d | L | Gallery layout absent **done** (net-gaps): a gallery of each post's first picture |
| Thread members | THREAD_MEMBERS_UPDATE, THREAD_MEMBER_LIST_UPDATE | none | a | L | **not built**: no member lists (owner's decision); only this account's own membership is read (THREAD_MEMBER(S)_UPDATE) |
| Private archived threads you are in | MY_ARCHIVED_THREADS | `threads` lists public archived via search | d | L | **done** (net-gaps): `threads` with `mine`, the thread browser's Private tab |
| Voice text chat (text in voice channels) | type 2 channels carry messages | mapped as 'voice' conversation | d | M | Check the web UI shows the voice channel's chat **done**: already shown with a message box (checked, net-gaps) |
| Channel types 17–21 (lobby, DM_SDK, media thread, guild space, guild app) | ChannelTypes | not mapped | a | L | GUILD_SPACE/rooms are an experiment (`2026-06_guild_rooms`, GUILD_ROOM*) **done** (net-gaps): media thread a thread, DM_SDK a DM, lobby a group, space and app a channel |
| Announcement channel follow | CHANNEL_FOLLOWERS, CHANNEL_FOLLOWER_CREATED | none | a | L | **not built**: following a channel into one of your servers is a server-admin act (L); Publish is built |
| Channel permission overwrites | CHANNEL_PERMISSIONS_OVERWRITE | read (canAll / everyoneDenies in About) | b | L | Moderator feature **not built**: moderator tool (L) |
| Channel create/delete/reorder, categories | GUILD_CHANNELS post/patch | none | a | L | ROADMAP: reorder later, low **not built**: moderator tool (L) |
| Voice channel status ("playing X") | UPDATE_VOICE_CHANNEL_STATUS, VOICE_CHANNEL_STATUS_UPDATE | none | a | L | **done** (net-gaps): VOICE_CHANNEL_STATUS_UPDATE and CHANNEL_INFO, shown with the channel's people |
| Webhooks | CHANNEL_WEBHOOKS, GUILD_WEBHOOKS, WEBHOOKS_UPDATE | none | a | L | **not built**: moderator tool (L) |
| Linked lobbies / game SDK DMs | CHANNEL_LINKED_LOBBY, DM_SDK 18, CHANNEL_LINKED_TO_LOBBY type 49 | none | a | L | **not built**: only shown (types 17, 18 above), nothing of the lobby itself (L) |
| Channel icons / emoji in channel names | CHANNEL_ICON | none | a | L | **not built**: L, not read |
| Group DM: change icon, transfer owner, remove member, leave | CHANNEL patch icon/owner, CHANNEL_RECIPIENT del, USER_CHANNELS_BULK_LEAVE | rename/topic yes; avatar refused (`PICTURE`); add members yes | d | M | Leave a group DM / kick from one: client-path **done** (net-gaps): leave (silently, asked), remove someone and make owner (the owner, confirmed), change or remove the picture (threads.md) |
| Close DM / bulk leave | USER_CHANNELS_BULK_LEAVE, CHANNEL del | none | a | L | **done** (net-gaps): Close on a DM (only hidden in Discord; the hub keeps it); bulk leave not built (no such screen here) |

## Voice, video, calls, streaming

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Who is in which voice channel (not joined) | VOICE_STATE_UPDATES, VoiceStateStore | only participants of the call you are in (watchCall) | a | H | ROADMAP "who is in Discord voice". Arrives via the gateway for guilds the client has loaded: passive, no request. Same privacy class as presence (adversarial gate) **done** (net-gaps): behind the adversarial voice setting, on the channel's row, page and chat (calls.md "Voice channels") |
| Incoming DM / group call ringing | CALL_CREATE/UPDATE/DELETE (with `ringing`), CALL_RING, CALL_STOP_RINGING, INCOMING_CALL_MOVE | none | a | H | ROADMAP's "ringing push". Passive subscribe; answer = existing `call join` **done** (net-gaps): one alert per call, Answer and Decline (stopRinging), stops on any device (calls.md "Ringing") |
| Start a DM call (ring others) | CALL_RING, opcode 4 into a DM | call join exists for voice-variant conversations | d | M | Check DMs offer Call and that ring is sent **done** (net-gaps): Call in a DM or group DM joins, then CallActions.ring |
| Video (camera) | VOICE_STATE `self_video`, MediaEngine video | `video` flag read; no video | d | M | calls.md: video not done |
| Go Live / screen share, watching streams | STREAM_CREATE/WATCH/DELETE ops 18–22, STREAM_PREVIEW, STREAM_* actions | none | a | M | Watching a friend's stream is a common use |
| Stage channels | STAGE_INSTANCE_*, STAGE_INSTANCES, message types 27–31, raise hand | mapped as 'stage' variant | d | L | Speaker/audience roles, raise hand absent |
| Soundboard | SEND_SOUNDBOARD_SOUND, GUILD_SOUNDBOARD_*, opcode 31 | none | a | L | |
| Voice channel effects (emoji bursts) | VOICE_CHANNEL_EFFECTS, VOICE_CHANNEL_EFFECT_SEND | none | a | L | |
| Activities (embedded apps in calls) | EMBEDDED_ACTIVITY_*, ACTIVITIES, ACTIVITY_CHANNEL_LAUNCH | none | a | L | Would need the app iframe |
| Voice hangouts / voice history / "user duration" | CHANNEL_VOICE_HANGOUT, CHANNEL_VOICE_HISTORY, exps `2026-04_voice_user_duration`, `2026-02_past_vc_activity_messages` | none | a | L | Voice history could feed dither's activity log **not built**: voice history is a request of ours (GET /channels/{id}/voice-history), not something the client is sent; the voice log under the adversarial setting covers what is passive |
| Custom call sounds | CUSTOM_CALL_SOUNDS | none | a | L | |
| Clips | CLIPS_*, CLIP_FEEDBACK | none (desktop-app feature) | a | L | |
| Server mute/deafen/move members (mod) | GUILD_MEMBER patch `mute`/`deaf`/`channel_id` | none | a | L | |
| Noise suppression, input sensitivity, per-user volume | MediaEngineStore settings, AUDIO_SET_LOCAL_VOLUME | bridge mode uses the client's defaults | d | L | |

## Servers: membership, onboarding, events

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Scheduled events: list, details, interested count | GUILD_EVENTS_FOR_GUILD, GUILD_SCHEDULED_EVENT_CREATE/UPDATE/DELETE, GUILD_EVENT_USER_COUNTS, USER_GUILD_EVENTS | none | a | H | They arrive in GUILD_CREATE and the gateway: passive. A natural feed for dither-calendar **done** (net-gaps): passive from the store and gateway, a server's Events card, a calendar feed (docs/servers.md) |
| RSVP ("Interested") | USER_GUILD_EVENT (put/del), GUILD_SCHEDULED_EVENT_USER_ADD/REMOVE | none | a | M | client-path **done** (net-gaps): Interested on and off, the series or one occurrence |
| Event recurrence exceptions | GUILD_EVENT_EXCEPTIONS, GUILD_SCHEDULED_EVENT_EXCEPTION_* | none | a | L | Needed for correct calendar recurrences **done** (net-gaps): read, as EXDATEs and moved occurrences in the calendar feed |
| Create/edit events | GUILD_EVENTS_FOR_GUILD post | none | a | L | **not built**: Discord's form has many parts (place, picture, recurrence); not cheap |
| Onboarding (pick channels/roles on join) | GUILD_ONBOARDING, GUILD_ONBOARDING_RESPONSES, GUILD_ONBOARDING_* | join returns "rules" wait (rulesWait) | d | M | After joining from dither, onboarding prompts cannot be answered; some servers hide channels until done **done** (net-gaps): answered from the server's page through the client's own onboarding actions |
| Membership screening / rules gate | GUILD_MEMBER_VERIFICATION, GUILD_MEMBER_REQUEST_TO_JOIN | detected as a check | d | M | add.md: "Ask" not built **done** (net-gaps): the rules shown, agreed only by the owner's tick |
| Join requests (apply to join) | GUILD_JOIN_REQUEST(S), GUILD_JOIN_REQUEST_CREATE/UPDATE, types 52–54 | not built (docs/chat.md "Not built: Ask") | a | L | **done** (net-gaps): the application's questions answered from the server's page, its outcome as a gate event |
| Leave a server | GUILD_LEAVE (`/users/@me/guilds/{id}` del) | none | a | M | Protocol has `leave` events but no command **done** (net-gaps): `leave` command, confirm, the owner told why not; group DMs and Signal groups left to a later package |
| Server nickname (self) | GUILD_MEMBER_NICK, SET_GUILD_MEMBER | read (nickOf); dither has per-account local nicknames only | b | L | **done** (net-gaps): `setNick`, a card on the server's page |
| Per-server profile (avatar, bio, banner) | USER_GUILD_PROFILE, GUILD_MEMBER_PROFILE_UPDATE | not read | a | L | **not built**: not cheap enough this round |
| Server tag / clan identity | USER_SET_GUILD_IDENTITY (`/users/@me/clan`) | none | a | L | **not built**: not read yet |
| Role self-assign via onboarding / role connections | GUILD_ROLE_CONNECTIONS_*, APPLICATION_USER_ROLE_CONNECTIONS | none | a | L | **not built**: roles through onboarding are; role connections are not |
| Server folders (sidebar) | user settings proto guild_folders, GUILD_FOLDER_* | none; dither has its own folders | a | M | Importing Discord's folders once would seed dither's sidebar for free (USER_SETTINGS_PROTO is already in the client). **done** (net-gaps): read with the settings proto; "Add Discord's folders to your sidebar" makes new folders once, never moving one you placed |
| Server discovery / directory | GUILD_DISCOVERY*, GLOBAL_DISCOVERY_SERVERS, DIRECTORY_CHANNEL_* | none | a | L | **not built**: out of scope |
| Server templates | GUILD_TEMPLATE(S) | none | a | L | **not built**: out of scope |
| Server boosting | APPLIED_GUILD_BOOST*, GUILD_BOOST types 8–11 | system lines | d | L | **not built**: out of scope (system lines only) |
| Server shop / role subscriptions / guild products | SERVER_SHOP, GUILD_ROLE_SUBSCRIPTION_*, GUILD_PRODUCT* | none | a | L | **not built**: monetisation |
| Guild home / server guide / welcome screen | GUILD_HOME_SETTINGS, GUILD_WELCOME_SCREEN | none | a | L | **not built**: out of scope |
| Server theme / powerups | GUILD_THEME, GUILD_POWERUPS, exp `2026-04_server_theme` | none | a | L | **not built**: out of scope |
| Invite create / revoke / list | INSTANT_INVITES, GUILD_INSTANT_INVITES, INVITE del | AboutChange `invite` exists; about.ts throws "Invite links are not supported on Discord yet" | b | M | Protocol/UI exist (Show QR beside a place's invite link); adapter refuses. client-path **done** (net-gaps): links listed with uses and expiry, made with Discord's choices, turned off |
| Friend invites (links that add a friend) | FRIEND_INVITES | accept yes (`inviteAccept` with friend) | d | L | Creating one: no **not built**: making one is left out |
| Vanity URL | GUILD_VANITY_URL | not shown | a | L | **done** (net-gaps): shown on the server's invite card |

## Moderation and admin

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Kick / ban / timeout | GUILD_MEMBER del, GUILD_BAN, BULK_GUILD_BAN_V2, `communication_disabled_until` | none | a | L | Only matters if the user moderates |
| Audit log | GUILD_AUDIT_LOG, GUILD_AUDIT_LOG_ENTRY_CREATE | none | a | L | |
| AutoMod rules | GUILD_AUTOMOD_RULES, GUILD_AUTOMOD_ALERT_ACTION, AUTO_MODERATION_MENTION_RAID_DETECTION | none | a | L | |
| Raid / incident actions | GUILD_INCIDENT_ACTIONS, types 36–39 | system lines | d | L | |
| Roles: create/edit/assign | GUILD_ROLES, GUILD_ROLE, GUILD_ROLE_CREATE/UPDATE | role names read, role changes logged (`role` event) | b | L | |
| Role member lists | GUILD_ROLE_MEMBER_IDS, GUILD_ROLE_MEMBER_COUNTS | none | a | – | **no**: active member scraping |
| Member search / safety (mods) | GUILD_MEMBER_SEARCH, MEMBER_SAFETY_SUPPLEMENTAL, GUILD_MEMBERS_UNUSUAL_DM_ACTIVITY | walkMembers (op 8, explicit index job) | d | – | **no** beyond what exists: active scraping |
| Prune | GUILD_PRUNE(_V2) | none | a | L | |
| Emoji/sticker/soundboard management | GUILD_EMOJIS, GUILD_STICKER, GUILD_SOUNDBOARD_SOUND, EMOJI_UPLOAD_* | none | a | L | |
| Server settings beyond name | GUILD patch (icon, banner, description, verification level, system channel, AFK…) | name only (PATCHABLE.guild) | d | L | |
| Channel settings beyond name/topic/slowmode/nsfw | CHANNEL patch (default auto-archive, user limit, bitrate, region, tags, default reaction, sort) | name/topic/slowmode/nsfw | d | L | announceOnly and avatar refused |
| Moderator reports / DSA | MODERATOR_REPORT_CLOSE, SUBMIT_MODERATOR_MESSAGE_REPORT, REPORT_TO_MOD_REOPEN | none | a | L | |
| Integrations / bots in a server | GUILD_INTEGRATIONS, GUILD_APPLICATIONS | none | a | L | |

## People, friends, profiles

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Ignore user (soft block) | IGNORE_USER, RELATIONSHIP_IGNORE_USER_SUCCESS / _UNIGNORE_ | none | a | M | ROADMAP "Block, ignore" later; ignore is the cheap one. **done** (net-gaps): Ignore / Stop Ignoring in a person's menu (docs/account-self.md); an ignored person never alerts |
| Block a user | USER_RELATIONSHIP put type 2 | blocks are read (relationships) and unblock is supported (`remove`); no block action | b | M | client-path via RelationshipActions. **done** (net-gaps): the shared `block` command (with Signal's), Block and Unblock in a person's menu, through addRelationship type 2 / removeRelationship; a blocked person never alerts |
| Friend nicknames (yours for them) | relationship `nickname` | deliberately not read (docs/chat.md) | – | – | A user decision, not a gap. **not built**: the owner's decision stands |
| User notes (your private note on someone) | NOTE / NOTES, USER_NOTE_UPDATE | none; dither has its own profile note | a | M | One-time import plus sync would merge them. client-path. **done** (net-gaps): `contactNotes` as Signal's: read with a profile only, joined with your dither note so neither is lost, written back with `setContact` |
| Friend suggestions / friend finder / contact sync | FRIEND_SUGGESTIONS, FRIEND_SUGGESTION_CREATE, FRIEND_FINDER, CONNECTION_SYNC_CONTACTS | none | a | L | **not built**: L, and contact sync would upload the owner's address book |
| Profile: banner, pronouns, theme colors, effects, decorations, badges | USER_PROFILE (banner, pronouns, theme_colors, profile_effect, avatar_decoration), USER_BADGES | profile.ts maps bio, mutuals, connections | d | L | **done** (net-gaps): badges, theme colours and the avatar decoration added to banner and pronouns; profile effects not built (animation only) |
| Profile widgets / game profile | USER_PROFILE_WIDGETS, GAME_PROFILE, exp `2026-03_voice_badge` | none | a | L | **not built**: L, game-only |
| Edit own profile beyond bio | `/users/@me/profile` patch: pronouns, banner, accent; USER patch: avatar, global_name; RECENT_AVATARS | bio only (`setProfile`) | d | M | Display name and avatar are the useful ones. **done** (net-gaps): `setProfile` takes name, avatar (Signal's fields) and pronouns, banner, accent, where the profile's `editable` lists them |
| Own presence status (online/idle/DND/invisible) | USER_SETTINGS_PROTO status, opcode 3 | the sandbox sits at whatever it is; no control | a | M | DND sync with dither quiet hours is an obvious pairing. client-path via settings proto. **done** (net-gaps): `setPresence` through the settings proto; opt-in Do not disturb during quiet hours |
| Own custom status | USER_SETTINGS_PROTO custom_status | read for friends only; cannot set own | b | M | dither has a `customStatus` event already. **done** (net-gaps): text, emoji and when it clears; a server's own emoji only in the live view |
| Activities / rich presence of friends (playing, listening) | PresenceStore activities, USER_ACTIVITY_* | custom status only (game/song changes skipped on purpose) | d | L | Adversarial-gate material; the skip was intended. **not built**: the skip stays intended |
| Spotify listen-along / join activity | USER_ACTIVITY_JOIN | none | a | L | **not built**: L, nothing in dither plays along |
| Mutual friends | USER_PROFILE `mutual_friends` | profile.ts reads mutuals (guilds; friends where returned) | d | L | **done** (already: profile.ts reads them where Discord returns them; the profile shows them) |
| Connections (linked accounts) | USER_PROFILE connected_accounts | read (pickConnection) | – | – | Done |
| Username suggestions / pomelo | POMELO_* | n/a | – | – | |
| Affinities ("people you talk to most") | USER_AFFINITIES_V2, CHANNEL_AFFINITIES_V2, GUILD_AFFINITIES | none | a | L | dither computes its own from history; Discord's could prior the inbox ranking. Odd-traffic is low; the client fetches it itself. **not built**: dither ranks from its own history; a Discord prior needs a replay to show it helps (docs/account-self.md) |

## Settings, sessions, account

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| User settings sync (proto: folders, status, appearance, privacy, content filters, DM settings, inline media) | USER_SETTINGS_PROTO, USER_SETTINGS_PROTO_UPDATE | none | a | M | Read-only ingest gives folders, status, "allow DMs from server members", and explicit-content filter in one place. **done** (net-gaps), read-only: status, custom status, folders, DM and message-request privacy, the age check, as `selfState`; appearance, content filters and inline media not read |
| Privacy: DMs from server members, message request toggle | settings proto `restricted_guilds`, `message_request_restricted_guild_ids` | none | a | L | **done** (net-gaps): shown as lines on the account page; changed in the live view |
| Active sessions / log out other devices | AUTH_SESSIONS, AUTH_SESSIONS_LOGOUT, SESSIONS_REPLACE, AUTH_SESSION_CHANGE | none | a | M | Useful as a security card: "your Discord is signed in on N devices", and to see the sandbox session itself. **done** (net-gaps): "Where is Discord signed in?" on the account page (`sessions`); signing out needs the password: the live view |
| Account standing / warnings | ACCOUNT_STANDING, SAFETY_HUB*, USER_REQUIRED_ACTION_UPDATE | login issues only | d | M | An account strike or "required action" (verify phone/age) silently stalls the adapter. Subscribing USER_REQUIRED_ACTION_UPDATE would surface it as an attention card. **done** (net-gaps): required actions and the standing (once the client read it) as `notices`, cards on the account page, never dismissed by code |
| Age verification / assurance | AGE_VERIFICATION_*, AGE_SIGNAL*, VERIFY_AGE(_V2) | none | a | M | Increasingly gating NSFW/age-restricted channels (UK/AU rules); should show as an attention card, never be automated. **done** (net-gaps), partly: REQUIRE_SAFETY_FLOWS as a notice and the age check as a privacy line; a channel's own age gate is met in the live view |
| MFA / password / email | MFA_*, USER_EMAIL, RESET_PASSWORD | live view only | a | L | Keep it in the live view. **not built**: live view, as intended |
| Data export (harvest) | USER_HARVEST | import uses its own path (import-discord.md) | a | L | A one-click "request my data" would feed the history importer. **not built**: requested in the live view (Privacy & Safety); the import then reads it (import-discord.md) |
| Streamer mode | STREAMER_MODE_UPDATE | none | a | L | **not built**: L, a client-display setting |
| Keybinds, appearance, locale | settings proto | n/a | – | – | |

## Search and discovery

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Message search, DMs-wide | SEARCH_TABS_DMS (`/users/@me/messages/search/tabs`) | search scope conversation/space/all; "all" across DMs? | d | M | Discord now searches all DMs in one request; the adapter searches one place at a time |
| Search tabs (messages/media/files/links/pins) | SEARCH_TABS_CHANNEL/GUILD/DMS | one result list | d | L | |
| Smart search (AI) | SMART_SEARCH (`/guilds/{id}/intelligence/search`) | none | a | L | Gated |
| Suggested/recent searches synced | SUGGESTED_SEARCHES | dither keeps its own | – | – | |
| Thread search | THREAD_SEARCH | used by `threads` | – | – | Done |
| GIF/sticker/emoji search | GIFS_SEARCH, EMOJI_PACKS, TOP_EMOJIS_FOR_GUILD | emoji complete in composer; custom emoji in reaction picker | d | L | TOP_EMOJIS_FOR_GUILD could order dither's picker |
| Quick switcher (Ctrl+K) | QUICKSWITCHER_* | dither has its own | – | – | Not a gap |

## Nitro, monetization, social extras (low value; listed for completeness)

| Feature | Discord has | dither has | Class | Value | Notes |
|---|---|---|---|---|---|
| Nitro-only emoji everywhere, animated avatars | EmojiRules | reaction picker respects EmojiRules | – | – | Done for reactions; for sending custom emoji in text, check the composer offers them |
| Custom emoji in sent text | `<:name:id>` in content | composer autocomplete has custom emoji (emojiComplete.ts) | – | – | Done; whether it applies EmojiRules (Nitro/permission) when sending was not checked |
| Gifts / gift codes in messages | GIFT_CODE_RESOLVE, GIFT_CODE_REDEEM, embeds for discord.gift | shown as a link | d | L | |
| Quests, orbs, collectibles, shop | QUESTS*, ORBS_*, COLLECTIBLES_* | none | a | L | Ignore |
| Super reactions | burst | done | – | – | |
| Chat wallpapers | CHAT_WALLPAPER_SET type 56 | none | a | L | |
| Game invites / game servers / lobbies | GAME_INVITE(S), GAME_SERVERS, LOBBY | none | a | L | |
| Family center | FAMILY_CENTER_* | none | a | L | |
| Conjure (app builder) | CONJURE_* | none | a | L | New, staff/experimental |

## Protocol/hub-only gaps (Discord data in the adapter, not used further)

| Feature | Where | Class | Value | Notes |
|---|---|---|---|---|
| Embeds rendered | `MessageFact.extra.embeds` → web Timeline renders | – | – | Done (subset) |
| Roles/members seen | `members` event gated by adversarial setting | – | – | Intended |
| Presence | `presence` event → profile Activity | – | – | ROADMAP: next |
| `reactors` list | adapter + protocol + web Reactions.tsx | – | – | Done |
| `threads` command | hub index jobs only | c | L | Not offered as a "show archived threads" button in a channel **done** (net-gaps): Browse Threads and Show archived threads; the page names its threads (`ThreadsResult.ids`) |
| Discord `mute` in ConversationFact | read at snapshot | d | M | The hub uses it for triage, but it never updates live (above) **done** (net-gaps): live through the settings actions above |

## Counts

About 150 rows. By class: (a) about 105, (b) 10, (c) 1, (d) about 30. Rows marked "–" are notes on things already done or out of scope.
