/**
 * Files your chats already hold, newest first, from the hub's own search (`has:file`, `has:image`; docs/search.md):
 * every network's, sent or received. The panel offers them to send again, with no picker and no permission.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';

export interface HubFile {
  /** The pick's id: `hub:<attachment>`. */
  id: string;
  att: P.AttachmentView;
  message: P.MessageView;
}

export function useHubFiles(query: string, kinds: P.AttachmentKind[]) {
  const [items, setItems] = useState<HubFile[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const page = async (cursor: string | null, into: HubFile[]) => {
    setLoading(true);
    try {
      const r = await api<P.SearchPage>(`/api/search?q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const seen = new Set(into.map((f) => f.att.url));
      const got = [...into];
      for (const h of r.hits)
        for (const a of h.message.attachments ?? [])
          if (kinds.includes(a.kind) && !seen.has(a.url)) {
            seen.add(a.url);
            got.push({ id: `hub:${a.id}`, att: a, message: h.message });
          }
      setItems(got);
      setNext(r.next);
      setFailed(null);
    } catch (e: any) {
      setFailed(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setItems([]);
    void page(null, []);
  }, [query]);
  return { items, loading, failed, more: next ? () => !loading && page(next, items) : null };
}
