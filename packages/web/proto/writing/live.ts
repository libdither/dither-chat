/** What the page knows and the editor asks: set by the page on every draw, read when a key is pressed. */
export interface Person {
  label: string;
  kind: string;
  ids: Record<string, string>;
}
export const live = {
  /** Some place the draft goes to carries this as itself. */
  carries: (_what: string) => true,
  /** The places that would show hidden text, by name; empty when none would. */
  exposes: () => '',
  /** The places that have no way to tell this person, by name. */
  quiet: (_attrs: Record<string, any>) => '',
  /** Enter sends (a chat box that is not opened up). */
  enterSends: () => false,
  send: () => {},
  /** What an empty box says. */
  hint: () => '',
  people: [] as Person[],
};
