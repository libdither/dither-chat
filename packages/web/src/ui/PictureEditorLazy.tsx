/**
 * Changing a picture (PictureEditor.tsx, docs/profile.md) is a chunk of its own, loaded the first time a page shows a
 * picture you may change.
 */
import { useEffect, useState } from 'preact/hooks';

type Parts = typeof import('./PictureEditor.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./PictureEditor.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** The parts once loaded; asked for only while `want`. */
export function usePictureEditor(want: boolean): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (want && !m) load().then(setM, () => {});
  }, [want]);
  return m;
}
