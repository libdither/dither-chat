/**
 * Who is in a call or a voice channel right now, and where (docs/calls.md "In a call now"): one lookup for every
 * row's in-call icon (ui/CallBar.tsx VoiceNowMark), built once each time what it is made of changes, never per row.
 *
 * Made of the voice channels' people (ringing.ts `voice`, filled only with the adversarial `voice` setting on), the
 * calls the hub told this page about that are going on (`liveCalls`), and the call this device is in (call.ts
 * `activeCall`). Names and people come from `db`, which `metaRev` says has changed. The builder is voiceplaces.ts.
 */
import { computed } from '@preact/signals';
import { activeCall } from './call.ts';
import { liveCalls, voice } from './ringing.ts';
import { db, isSelfIdentity, metaRev } from './state.ts';
import { communitiesOf, convTitle } from './model.ts';
import { buildVoiceNow, voiceNowFrom, voiceNowText, type VoiceLook, type VoiceNow } from './voiceplaces.ts';

const look: VoiceLook = {
  conv: (id) => db.conversations.get(id),
  personOf: (id) => db.identities.get(id)?.personId ?? null,
  isSelf: isSelfIdentity,
  name: (id) => {
    const i = db.identities.get(id);
    const person = i?.personId ? db.persons.get(i.personId) : null;
    return person?.name ?? i?.displayName ?? i?.handle ?? 'Someone';
  },
  placeName: (id) => {
    const c = db.conversations.get(id);
    if (!c) return 'a call';
    const com = c.shape === 'channel' || c.shape === 'thread' ? communitiesOf(c)[0] : undefined;
    const name = c.shape === 'channel' || c.shape === 'thread' ? `#${convTitle(c)}` : convTitle(c);
    return com ? `${name} · ${com.name}` : name;
  },
};

/**
 * The lookup as text first: a mute, a camera or a speaking light changes the inputs but not who is where, and the
 * text then comes out the same, so the rows' icons (which read `voiceNow`) are not told about it.
 */
const text = computed(() => {
  metaRev.value; // names, places and which person an identity is
  return voiceNowText(buildVoiceNow(voice.value.values(), liveCalls(), activeCall.value, look));
});

/** Who is in a call or a voice channel right now (see above). */
export const voiceNow = computed<VoiceNow>(() => voiceNowFrom(text.value));
