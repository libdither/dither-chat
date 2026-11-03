import { describe, expect, test } from 'bun:test';
import { answer, codecPt, firstSsrc, offerForServer } from '../src/voice/sdp.ts';

// A Chrome-shaped local offer: our audio (mid 0, sendrecv) and one receive slot (mid 1).
const LOCAL = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=extmap-allow-mixed',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdef012345',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 AA:BB',
  'a=setup:actpass',
  'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=sendrecv',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=ssrc:1234 cname:x',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=mid:1',
  'a=recvonly',
  'a=rtpmap:111 opus/48000/2',
  '',
].join('\r\n');

const SERVER = ['m=audio 50012 ICE/SDP', 'a=fingerprint:sha-256 CC:DD', 'c=IN IP4 203.0.113.7', 'a=rtcp:50012', 'a=ice-ufrag:Xy12', 'a=ice-pwd:serverpwd', 'a=candidate:1 1 UDP 4261412862 203.0.113.7 50012 typ host'].join('\n');

describe('direct-mode SDP', () => {
  test('the offer the server sees keeps ICE, extensions, fingerprint and opus only, LF-joined', () => {
    const o = offerForServer(LOCAL);
    expect(o.split('\n')).toEqual([
      'a=extmap-allow-mixed',
      'a=ice-ufrag:abcd',
      'a=ice-pwd:0123456789abcdef012345',
      'a=ice-options:trickle',
      'a=fingerprint:sha-256 AA:BB',
      'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
      'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
      'a=rtpmap:111 opus/48000/2',
    ]);
  });

  test('own SSRC and opus payload type come from the offer', () => {
    expect(firstSsrc(LOCAL)).toBe(1234);
    expect(codecPt(LOCAL, 'opus')).toBe(111);
  });

  test('the answer copies the server transport into every section and mirrors directions', () => {
    const a = answer(SERVER, LOCAL, new Map([['1', { id: '222', ssrc: 4242 }]]), 111);
    const secs = a.split('\r\nm=');
    expect(secs[0]).toContain('a=group:BUNDLE 0 1');
    expect(secs[1]).toStartWith('audio 50012 UDP/TLS/RTP/SAVPF 111');
    for (const s of secs.slice(1)) {
      expect(s).toContain('a=setup:passive');
      expect(s).toContain('a=ice-ufrag:Xy12');
      expect(s).toContain('a=candidate:1 1 UDP 4261412862 203.0.113.7 50012 typ host');
      expect(s).toContain('c=IN IP4 203.0.113.7');
    }
    // Our sendrecv section with nobody assigned: the server only receives.
    expect(secs[1]).toContain('a=recvonly');
    // The receive slot carrying user 222's audio.
    expect(secs[2]).toContain('a=sendonly');
    expect(secs[2]).toContain('a=ssrc:4242 cname:222-4242');
    expect(secs[2]).toContain('a=msid:222-4242 a222-4242');
    expect(secs[1]).toContain('a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level');
  });

  test('an unassigned receive slot is inactive', () => {
    const a = answer(SERVER, LOCAL, new Map(), 111);
    expect(a.split('\r\nm=')[2]).toContain('a=inactive');
  });
});
