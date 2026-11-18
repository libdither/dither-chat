/**
 * The replies a followed post's chat had found since it was last read (docs/feed.md "Following a post"), by post id:
 * set by its pane (Follow.tsx) as it opens, read by the comment tree (Comments.tsx), which marks them New. Empty
 * while no such chat is open.
 */
import { signal } from '@preact/signals';

export const freshReplies = signal<ReadonlySet<string>>(new Set());
