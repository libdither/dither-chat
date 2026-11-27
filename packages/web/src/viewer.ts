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
  /** Fit it to the screen even where that enlarges it: a profile's picture, often smaller than the screen. */
  fill?: boolean;
  /** A second line under the name: where a profile's picture comes from. */
  detail?: string;
}
/**
 * Pictures to choose one of (a person's accounts' pictures, on their profile): the one in use is `on`, and the viewer
 * offers to use the one it is showing instead.
 */
export interface ViewerChoice {
  on: number;
  pick: (index: number) => unknown;
}
export const viewer = signal<{ images: ViewerImage[]; index: number; choose?: ViewerChoice } | null>(null);
