/**
 * Sensitive messages (docs/sensitive.md): the local model's chance that a message should stay off a screen others can
 * see, two lines on that chance (cover, then hide), and your answers on whether it was right, which score the question
 * the model is asked so a better one can replace it.
 */

/** How a covered message looks: blurred, or its words as black bars of their own length. */
export type SensitiveStyle = 'blur' | 'bar';
/** Above the hide line: folded to one line in its place, or gone from the chat with a count at the top. */
export type SensitiveTop = 'line' | 'gone';

export interface SensitiveSettings {
  on: boolean;
  /** Covered from this chance up. */
  cover: number;
  /** Hidden from this chance up; at least `cover`. */
  hide: number;
  style: SensitiveStyle;
  top: SensitiveTop;
}

export const SENSITIVE_DEFAULTS: SensitiveSettings = { on: false, cover: 0.4, hide: 0.75, style: 'blur', top: 'line' };

/** On a MessageView: the model's chance (from the question in use, else the newest that judged it) and your answer. */
export interface SensitiveMark {
  p: number;
  /** The question's version that gave `p`. */
  v: number;
  /** Your answer: true it is sensitive, false it is fine. */
  vote?: boolean;
}

/** What the page does with a message, given the settings. */
export type SensitiveLevel = 'shown' | 'cover' | 'hide';
export function sensitiveLevel(s: SensitiveSettings | null | undefined, mark: SensitiveMark | undefined): SensitiveLevel {
  if (!s?.on || !mark) return 'shown';
  // Your own answer wins over the model's chance.
  if (mark.vote === false) return 'shown';
  if (mark.vote === true) return mark.p >= s.hide ? 'hide' : 'cover';
  return mark.p >= s.hide ? 'hide' : mark.p >= s.cover ? 'cover' : 'shown';
}

export interface SensitivePromptView {
  version: number;
  question: string;
  madeAt: number;
  /** When it was put in use; null for one only tried. */
  adoptedAt: number | null;
  inUse: boolean;
}

/** How a question's chances agree with your answers. */
export interface SensitiveAgreement {
  version: number;
  /** Answers it judged. */
  n: number;
  /** Answers it has not judged yet. */
  unjudged: number;
  /** At the cover line: the model covers/hides (yes) or shows (no), against your answer. */
  matrix: { yesSensitive: number; yesFine: number; noSensitive: number; noFine: number };
  /** Share of answers where the cover line agrees with you; null with no answers. */
  agreement: number | null;
  /** Average precision of the chances against your answers (order only, no line); null without a "sensitive" answer. */
  ap: number | null;
  /** The cover line that would agree with you most, and how much. */
  best: { line: number; agreement: number } | null;
}

/** A message the model and you disagree on (at the cover line). */
export interface SensitiveDisagreement {
  messageId: string;
  p: number;
  vote: boolean;
}

/** GET /api/sensitive */
export interface SensitiveState {
  settings: SensitiveSettings;
  /** The question in use. */
  version: number;
  prompts: SensitivePromptView[];
  agreement: SensitiveAgreement;
  /** Whether a model is there to ask (`off` hubs and failed models: none). */
  model: string | null;
  /** Messages waiting to be asked about. */
  pending: number;
}

/** POST /api/sensitive/prompts: a question tried on your answers. */
export interface SensitiveTrial {
  prompt: SensitivePromptView;
  agreement: SensitiveAgreement;
  inUse: SensitiveAgreement;
}
