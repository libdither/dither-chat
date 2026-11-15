/**
 * What the picture viewer (ui/Viewer.tsx) shows, when it is open. Its own module, so the activity log (activity.ts)
 * can tell the viewer is open without importing the viewer's component (docs/testing.md "Import cycles").
 */
import { signal } from '@preact/signals';

export interface ViewerImage {
  url: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
}
export const viewer = signal<{ images: ViewerImage[]; index: number } | null>(null);
