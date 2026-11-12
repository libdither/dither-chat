/**
 * The palette's pages (docs/palette.md), a chunk of their own: loaded once the app is idle, or when the palette first
 * opens, so the first load does not carry them (docs/perf.md).
 */
import type { Entry } from '../palette.ts';
import { AddPage, GroupsPage } from './AddMembers.tsx';
import { GroupPage, NamePage, WherePage } from './NewGroup.tsx';
import { CardPage, MessagePage, MinePage, NewPage, ReachPage, ScanPage } from './NewPages.tsx';
import { RootPage } from './Switcher.tsx';

export function PageOf({ e }: { e: Entry }) {
  switch (e.kind) {
    case 'root':
      return <RootPage e={e} />;
    case 'new':
      return <NewPage e={e} />;
    case 'reach':
      return <ReachPage e={e} />;
    case 'message':
      return <MessagePage e={e} />;
    case 'card':
      return <CardPage e={e} />;
    case 'scan':
      return <ScanPage e={e} />;
    case 'mine':
      return <MinePage e={e} />;
    case 'groups':
      return <GroupsPage e={e} />;
    case 'add':
      return <AddPage e={e} />;
    case 'group':
      return <GroupPage e={e} />;
    case 'group-where':
      return <WherePage e={e} />;
    case 'group-name':
      return <NamePage e={e} />;
  }
}
