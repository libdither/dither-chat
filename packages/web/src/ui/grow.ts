/**
 * A text box that grows with what is in it, up to the cap its CSS sets (max-height), and scrolls inside past that,
 * as Discord's does. The cap is in CSS, so it follows the keyboard and the window by itself: about five lines on a
 * phone, never more than 40% of what is visible (styles.css, "composer").
 *
 * Where the browser sizes a field to its content (`field-sizing: content`: Chromium, so Android and its WebView), CSS
 * does it all and nothing here measures. Elsewhere the box is measured when its text changes, and never while it is
 * empty, which is one line by `rows`: opening a chat lays nothing out.
 */
import { useLayoutEffect } from 'preact/hooks';

export const fieldSizing = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');

export function useGrow(ta: { current: HTMLTextAreaElement | null }, text: string) {
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || fieldSizing) return;
    if (!text) return void (el.style.height = '');
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
}
