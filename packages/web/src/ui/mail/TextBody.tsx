/**
 * A mail's text: plain text with its links, never Markdown; the quoted part folded behind ··· (mail/text.ts). For an
 * HTML-only message this is the text the extractor (or the hub) made from its HTML.
 */
import { useState } from 'preact/hooks';
import { linkify, splitQuote } from '../../mail/text.ts';
import type { BodyProps } from './slots.tsx';

function Linked({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p) =>
        'url' in p ? (
          <a href={p.url} target="_blank" rel="noreferrer noopener">
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

export function TextBody({ body }: BodyProps) {
  const [open, setOpen] = useState(false);
  if (!body.text) return <div class="mail-text mail-text-empty">This message has no text.</div>;
  const { shown, quoted } = splitQuote(body.text, body.quoteAt);
  return (
    <div class="mail-text">
      <Linked text={shown} />
      {quoted && (
        <>
          <button class="mail-quote-toggle" aria-expanded={open} title={open ? 'Hide the quoted text' : 'Show the quoted text'} onClick={() => setOpen(!open)}>
            ···
          </button>
          {open && (
            <div class="mail-quote">
              <Linked text={quoted} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
