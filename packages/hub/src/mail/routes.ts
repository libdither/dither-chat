/**
 * /api/mail/* (docs/mail-design.md §5). A table of routers: each slice keeps its routes in a file of its own and adds
 * one line to ROUTERS below, so slices built side by side do not edit the same handlers.
 *
 * A router is called once, when MailHub is made, with the hub. Besides its routes it may listen to the hub's events
 * there (`hub.on('ingested', …)`): that is where a slice's own work hooks in.
 *
 *   export const opsRoutes: MailRouter = (hub) => {
 *     hub.on('read', (e) => …);
 *     return [{ method: 'POST', path: /^\/api\/mail\/flag$/, handle: async (r) => Response.json(…) }];
 *   };
 *
 * Errors a handler throws become JSON `{ error }` with their `status` (MailCallError), else 500. The server checks the
 * origin of every non-GET request before it gets here.
 */
import type * as P from '@dither-chat/protocol';
import type { MailHub } from './index.ts';
import { peopleRoutes } from './people.ts';
import { sendRoutes } from './outbox.ts';
import { opsRoutes } from './ops.ts';
import { partRoutes } from './parts.ts';

export interface MailRequest {
  req: Request;
  url: URL;
  /** The path's capture groups, decoded. */
  params: string[];
  body<T = Record<string, unknown>>(): Promise<T>;
}

export interface MailRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: RegExp;
  handle(r: MailRequest): Promise<Response> | Response;
}

export type MailRouter = (hub: MailHub) => MailRoute[];

const ok = (x: unknown = { ok: true }) => Response.json(x);
const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** Slice 1: what reading needs. */
export const readRoutes: MailRouter = (hub) => [
  {
    method: 'GET',
    path: /^\/api\/mail$/,
    handle: () => {
      const b = hub.bootstrap();
      return ok({ access: b.access, accounts: b.accounts, mailboxes: b.mailboxes });
    },
  },
  {
    // ?list=<key>&before=<cursor>&limit=50
    method: 'GET',
    path: /^\/api\/mail\/threads$/,
    handle: ({ url }) => {
      const key = url.searchParams.get('list') ?? 'v:inbox:*';
      const page = hub.store.listThreads(key, url.searchParams.get('before'), Number(url.searchParams.get('limit')) || 50);
      return page ? ok(page satisfies P.MailThreadPage) : bad('no such list', 404);
    },
  },
  {
    method: 'GET',
    path: /^\/api\/mail\/threads\/([\w-]+)$/,
    handle: ({ params }) => {
      const d = hub.threadDetail(params[0]);
      return d ? ok(d satisfies P.MailThreadDetail) : bad('no such thread', 404);
    },
  },
  {
    // Read here: the reader says so once a thread has been in view a second.
    method: 'POST',
    path: /^\/api\/mail\/threads\/([\w-]+)\/read$/,
    handle: ({ params }) => {
      if (!hub.store.thread(params[0])) return bad('no such thread', 404);
      hub.readHere([params[0]]);
      return ok();
    },
  },
  {
    method: 'GET',
    path: /^\/api\/mail\/messages\/([\w-]+)\/body$/,
    handle: async ({ params }) => ok((await hub.body(params[0])) satisfies P.MailBodyView),
  },
  {
    // Pull to refresh: what changed, now. Without an account, every account.
    method: 'POST',
    path: /^\/api\/mail\/refresh(?:\/([\w-]+))?$/,
    handle: async ({ params }) => {
      await hub.refresh(params[0] || null);
      return ok();
    },
  },
  {
    // "Delete now", for an account whose access ended.
    method: 'DELETE',
    path: /^\/api\/mail\/accounts\/([\w-]+)$/,
    handle: ({ params }) => {
      const r = hub.deleteNow(params[0]);
      if (r === 'unknown') return bad('no such mail account', 404);
      if (r === 'active') return bad('the hub still has access to this account: remove it on the dither-accounts page first', 409);
      return ok();
    },
  },
  {
    // "Ask again" after you declined mail access.
    method: 'POST',
    path: /^\/api\/mail\/access$/,
    handle: async () => {
      await hub.askAgain();
      return ok({ access: hub.access() });
    },
  },
];

/** Every slice's router. Add yours here. */
const ROUTERS: MailRouter[] = [readRoutes, peopleRoutes, sendRoutes, opsRoutes, partRoutes];

export function mountRouters(hub: MailHub): MailRoute[] {
  return ROUTERS.flatMap((r) => r(hub));
}
