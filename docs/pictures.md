# Pictures in a chat

How the timeline draws pictures: how big one is on its own, which pictures go together, and the ways a chat can
draw a group of them. The code is `packages/web/src/pictures.ts` (sizes, runs), `packages/web/src/ui/Pictures.tsx`
(drawing) and `packages/web/src/arrange.ts` (which way a chat uses).

## One picture

A picture on its own fits inside 560 × 480, whole, and is never enlarged (`fitPicture`). Two shapes get a floor so
they stay readable:

| Shape | Drawn | Example |
|---|---|---|
| Long (a scrolling screenshot) | at least 200 px wide; past 480 px high it shows its top, with a fade and "Long picture" on it. The viewer shows all of it | 1080 × 6000 → 200 × 480 |
| Wide (a banner, a strip) | at least 64 px high; past 560 px wide it shows its middle | 6000 × 600 → 560 × 64 |
| Anything else | whole | 1648 × 254 → 560 × 86, 1080 × 2400 → 216 × 480 |

On a phone the box narrows to the column and keeps its shape.

A picture whose message came without its size (Signal leaves it out at times) is never cropped to a guess: it gets a
small box to load into, then its own shape once the image has loaded. The hub also reads the size from the file: a
picture without one has the media archive keep the new files at once (`Store.sizelessPictures`, `MediaArchiver.nudge`)
instead of at its next turn, up to a minute later, and the size it reads (`media_info`, docs/files.md) reaches the app
as the message's `info`.

## Runs

The network's albums are not kept apart. One person's messages with pictures, one after another, are one **run**,
whether they came as one album, several albums or one picture each (`pictureRuns`). A message joins the one before
it when the timeline would group them (same author and chat, less than seven minutes apart, same day, not a reply),
with no New line between. Words alone, a reply, a forward (its pictures stay in its card), a sticker or someone else
end a run. Only the messages drawn at the time are looked at, so a run can be cut at the edge of what is drawn.

The run's last message draws all of its pictures, after its own words. A message of the run that is nothing but its
pictures (no words, reactions, thread, marks, edits or files: `onlyPictures`) has no row of its own; an empty anchor
in the block stands for it, so a jump to it lands there. Every other message keeps its row, without its pictures.
Each tile is still its own message's: its menu (right-click, or hold on a phone) has that message's reply, react,
forward and delete, and a click opens the viewer on every picture of the run.

## The ways

| Way | `PictureLayout` | Draws |
|---|---|---|
| Mosaic, six and +N (the default) | `six` | the mosaic of the first six; the sixth says how many more and opens the viewer |
| Mosaic, all of them | `mosaic` | every picture as a tile of one block, in rows: one or two alone, three as one over two, then rows of three (`mosaicRows`). A tile is cropped to its row's height, and keeps its picture's shape within 0.6 to 1.8 (a lone top tile 1.25 to 2.4) |
| Rows, uncropped | `rows` | every picture whole, in rows of one height that fill the width (150 px a row to start, 110 on a phone) |
| Folded after the first | `fold` | the first picture on its own, then "Show N more" with thumbnails, which opens the mosaic of all |
| Small | `small` | every picture as an 88 px thumbnail (72 on a phone) |

A run of one picture is drawn on its own in every way but Small.

## The setting

For every chat: Settings → Appearance → "Pictures in chats". It is `ArrangeSettings.pictures`, shared by your
devices with the sort modes (`PATCH /api/arrange`, the `arrange` event; docs/organize.md). Absent means `six`.

For one chat or server: Pictures in its menu. It is a place pref (`place_pref.pictures`, PlacePrefView `pictures`,
`PATCH /api/place-prefs`), inherited like the @ list's setting (docs/mentions.md): the chat's own; a thread's
channel's; its spaces', nearest first; a folder's that holds any of them; else the one for every chat. `null` in a
patch takes it away. The menu's first entry is what the chat would inherit, and where from.
