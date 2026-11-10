/**
 * Ports for servers the test cannot start on port 0 itself: another process (a hub run from main.ts, Dovecot) or a
 * library that is told its port before it listens. The OS picks them, so they are free now, never one of the ports
 * people run hubs on, and no two test files guess the same one. All are held until the last is picked, so one call
 * never hands out the same port twice. A server in this process listens on port 0 instead and reads the port it got
 * (`hub.start().port`, `Bun.serve({ port: 0 }).port`).
 */
export function freePorts(n = 1): number[] {
  const held = Array.from({ length: n }, () => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() }));
  const ports = held.map((s) => s.port!);
  for (const s of held) s.stop(true);
  return ports;
}
