/**
 * The SDP side of Discord's web voice protocol (see docs/calls.md): what the server is sent of the
 * local offer, and the answer the client makes up from the server's single transport description.
 */

/** What the server is sent of the local offer: ICE credentials, header extensions, the fingerprint and the codec lines. LF-joined, duplicates dropped. */
export function offerForServer(sdp: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!/^a=ice|^a=extmap|^a=fingerprint|opus/i.test(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join('\n');
}

export function codecPt(sdp: string, name: string): number | null {
  const m = sdp.match(new RegExp(`^a=rtpmap:(\\d+) ${name}/`, 'im'));
  return m ? Number(m[1]) : null;
}

/** The SSRC of our own audio: the first a=ssrc line of the first sendrecv audio section. */
export function firstSsrc(sdp: string): number {
  for (const sec of sdp.split(/\r?\nm=/).slice(1)) {
    if (!sec.startsWith('audio') || !/a=sendrecv/.test(sec)) continue;
    const m = sec.match(/a=ssrc:(\d+) /);
    if (m) return Number(m[1]);
  }
  return 0;
}

interface Section {
  kind: string;
  mid: string;
  dir: string;
}
function sections(sdp: string): Section[] {
  return sdp
    .split(/\r?\nm=/)
    .slice(1)
    .map((sec) => ({
      kind: sec.split(' ')[0]!,
      mid: sec.match(/a=mid:(\S+)/)?.[1] ?? '',
      dir: sec.match(/a=(sendrecv|sendonly|recvonly|inactive)/)?.[1] ?? 'sendrecv',
    }));
}

/**
 * The remote answer, built locally as Discord's web client builds it: every section copies the
 * server's single transport (c=, rtcp, ICE, fingerprint, candidates), the browser is the DTLS
 * client, directions are mirrored, and a section carrying a remote user's audio names its SSRC.
 */
export function answer(server: string, local: string, assigned: Map<string, { id: string; ssrc: number }>, pt: number): string {
  const lines = server.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const port = lines.find((l) => l.startsWith('m='))?.split(' ')[1] ?? '9';
  const c = lines.find((l) => l.startsWith('c=')) ?? 'c=IN IP4 0.0.0.0';
  const pick = (re: RegExp) => lines.filter((l) => re.test(l));
  const transport = [...new Set([...pick(/^a=ice-ufrag:/), ...pick(/^a=ice-pwd:/), ...pick(/^a=fingerprint:/), ...pick(/^a=candidate:/), ...pick(/^a=ice-lite/)])];
  const rtcp = pick(/^a=rtcp:/)[0];
  const ext = (uri: string) => local.match(new RegExp(`^a=extmap:(\\d+)(?:/\\w+)? ${uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'))?.[1];
  const audioExt = [
    ['urn:ietf:params:rtp-hdrext:ssrc-audio-level', ext('urn:ietf:params:rtp-hdrext:ssrc-audio-level')],
    ['http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', ext('http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01')],
  ].filter(([, id]) => id);
  const secs = sections(local);
  const out = ['v=0', 'o=- 1420070400000 0 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=group:BUNDLE ${secs.map((s) => s.mid).join(' ')}`, 'a=msid-semantic: WMS *'];
  for (const s of secs) {
    const a = assigned.get(s.mid);
    const mirror = { sendrecv: 'sendrecv', sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive' }[s.dir] ?? 'inactive';
    const dir = a ? mirror : mirror === 'sendonly' ? 'inactive' : mirror === 'sendrecv' ? 'recvonly' : mirror;
    if (s.kind !== 'audio') {
      out.push(`m=${s.kind} 0 UDP/TLS/RTP/SAVPF 0`, c, `a=mid:${s.mid}`, 'a=inactive');
      continue;
    }
    out.push(`m=audio ${port} UDP/TLS/RTP/SAVPF ${pt}`, c, `a=rtpmap:${pt} opus/48000/2`, `a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`);
    if (rtcp) out.push(rtcp);
    out.push(`a=rtcp-fb:${pt} transport-cc`);
    for (const [uri, id] of audioExt) out.push(`a=extmap:${id} ${uri}`);
    out.push('a=setup:passive', `a=mid:${s.mid}`, `a=${dir}`, ...transport, 'a=rtcp-mux');
    if (a) {
      const id = `${a.id}-${a.ssrc}`;
      out.push(`a=msid:${id} a${id}`, `a=ssrc:${a.ssrc} cname:${id}`);
    }
    out.push('a=maxptime:60');
  }
  return out.join('\r\n') + '\r\n';
}

