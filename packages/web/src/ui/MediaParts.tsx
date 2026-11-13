/**
 * One chunk for the sticker picker, the voice recorder and stories (docs/media-kinds.md), loaded the first time any is
 * wanted (ComposerMedia.tsx, StoriesLazy.tsx). One chunk rather than two: each lazy chunk with a set of imports of its
 * own makes the bundler split shared code out of the startup chunks into more files.
 */
export * from './ComposerMediaParts.tsx';
export * from './Stories.tsx';
