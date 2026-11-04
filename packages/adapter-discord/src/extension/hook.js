/*
 * MAIN-world content script, injected at document_start on discord.com.
 *
 * This runs the real Discord web client's own modules (the Vencord approach): it
 * grabs webpack's require by pushing a chunk onto window.webpackChunkdiscord_app,
 * locates the Flux dispatcher, a handful of stores, the REST module and the
 * message actions, then (a) forwards a whitelisted snapshot + whitelisted live
 * events out to the ISOLATED world, and (b) runs commands through the client's
 * own code paths so requests look like any other action the user took.
 *
 * It never touches the network itself and never sees the adapter token; it only
 * posts window messages to content.js. Plain JS on purpose (no build step).
 */
(() => {
  'use strict';
  const TAG = '__dither_bridge__';
  const log = (level, msg, data) => post({ t: 'log', level, msg, data });
  const up = (payload) => post(payload);
  function post(payload) {
    try {
      window.postMessage({ [TAG]: 'up', payload }, location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------- webpack grab
  // Discord ships several rspack runtimes (web, fast-connect, sentry,
  // libdiscore-wasm-fetch) that share window.webpackChunkdiscord_app. Each one
  // wraps the push installed before it, and every chunk script assigns the
  // global again right before pushing. The hook must leave that chain exactly as
  // the runtimes built it: re-wrapping push on each assignment drops them out of
  // it, and lazy chunks then never load ("Loading chunk N failed").
  //
  // Each time a runtime installs its push we send a probe chunk down the chain.
  // Every runtime on it hands the probe its require, and module lookups search
  // all of their caches.
  const requires = new Set();

  function probe(chunks) {
    try {
      chunks.push([
        [Symbol(TAG)],
        {},
        (r) => {
          if (r && r.c) requires.add(r);
        },
      ]);
    } catch (e) {
      log('error', 'probe chunk failed', String(e));
    }
  }

  function installWebpackHook() {
    const hooked = new WeakSet();
    const hookArray = (chunks) => {
      if (!chunks || typeof chunks !== 'object' || hooked.has(chunks)) return;
      hooked.add(chunks);
      let push = chunks.push;
      Object.defineProperty(chunks, 'push', {
        configurable: true,
        get: () => push,
        set(fn) {
          push = fn;
          probe(chunks);
        },
      });
    };
    let stored = window.webpackChunkdiscord_app;
    if (stored) {
      // Injected late: some runtimes may already be on the chain.
      if (Object.prototype.hasOwnProperty.call(stored, 'push')) probe(stored);
      hookArray(stored);
    }
    Object.defineProperty(window, 'webpackChunkdiscord_app', {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set(v) {
        stored = v;
        hookArray(v);
      },
    });
  }

  // -------------------------------------------------------------- module lookup
  // rspack mangles export names, so every export of every module is a candidate.
  // Except i18n message bundles: they are Proxies that answer every key with a
  // function, so they would pass any shape test and sit ahead of the real modules.
  function answersAnyKey(v) {
    try {
      return v[TAG + 'no_such_key'] !== undefined;
    } catch (e) {
      return true;
    }
  }
  function candidates() {
    const out = [];
    const seen = new Set();
    const add = (v) => {
      if (v && typeof v === 'object' && !seen.has(v) && !answersAnyKey(v)) {
        seen.add(v);
        out.push(v);
      }
    };
    for (const r of requires) {
      const cache = r.c;
      for (const id in cache) {
        let exp;
        try {
          exp = cache[id] && cache[id].exports;
        } catch (e) {
          continue;
        }
        if (!exp || (typeof exp !== 'object' && typeof exp !== 'function') || exp === window) continue;
        add(exp);
        let keys;
        try {
          keys = Object.keys(exp);
        } catch (e) {
          continue;
        }
        if (keys.length > 64) continue; // icon sets, constant tables
        for (const k of keys) {
          try {
            add(exp[k]);
          } catch (e) {
            /* export binding not initialized yet */
          }
        }
      }
    }
    return out;
  }
  function moduleCount() {
    let n = 0;
    for (const r of requires) n += Object.keys(r.c).length;
    return n;
  }
  function storeName(m) {
    try {
      return typeof m.getName === 'function' && typeof m.emitChange === 'function' ? m.getName() : null;
    } catch (e) {
      return null;
    }
  }

  // --------------------------------------------------------------- the modules
  const isStore =
    (...names) =>
    (m) =>
      names.includes(storeName(m));
  const FINDERS = {
    Dispatcher: (m) => typeof m.dispatch === 'function' && typeof m.subscribe === 'function' && !!(m._actionHandlers || m._subscriptions || typeof m.isDispatching === 'function'),
    UserStore: isStore('UserStore'),
    GuildStore: isStore('GuildStore'),
    ChannelStore: isStore('ChannelStore'),
    GuildChannelStore: isStore('GuildChannelStore'),
    ReadStateStore: isStore('ReadStateStore'),
    RelationshipStore: isStore('RelationshipStore'),
    UserGuildSettingsStore: isStore('UserGuildSettingsStore'),
    GuildMemberStore: isStore('GuildMemberStore'),
    // Newer builds keep roles here rather than on the guild record; older ones have neither store.
    GuildRoleStore: isStore('GuildRoleStore'),
    GuildMemberCountStore: isStore('GuildMemberCountStore'),
    ThreadStore: isStore('ThreadsStore', 'ThreadStore', 'ActiveThreadsStore'),
    EmojiStore: isStore('EmojiStore'),
    PermissionStore: isStore('PermissionStore'),
    // The client's own answer to "can I use this emoji here", Nitro and permissions included.
    EmojiRules: (m) => typeof m.getEmojiUnavailableReason === 'function',
    // The client's own in-memory log, which records every failed request with its response body.
    ClientLog: (m) => {
      const v = Object.values(m);
      return v.length <= 4 && v.some(isLogReader);
    },
    // REST client: an object exposing the http verbs.
    Rest: (m) => ['get', 'post', 'put', 'patch', 'del'].every((k) => typeof m[k] === 'function'),
    // Message actions: sendMessage / editMessage / fetchMessages.
    MessageActions: (m) => typeof m.sendMessage === 'function' && typeof m.editMessage === 'function',
    // Opening DMs: the module the client's own "Message" button uses.
    PrivateChannelActions: (m) => typeof m.openPrivateChannel === 'function',
    // Typing: what the client's own composer calls on a keystroke (it sends and throttles POST /typing itself).
    TypingActions: (m) => typeof m.startTyping === 'function' && typeof m.stopTyping === 'function',
    // Calls: what the client's own voice channel buttons call, and the stores its call panel reads.
    VoiceActions: (m) => typeof m.selectVoiceChannel === 'function' && typeof m.disconnect === 'function',
    AudioActions: (m) => typeof m.toggleSelfMute === 'function' && typeof m.toggleSelfDeaf === 'function',
    VoiceStateStore: isStore('VoiceStateStore'),
    SpeakingStore: isStore('SpeakingStore'),
    MediaEngineStore: isStore('MediaEngineStore'),
    SelectedChannelStore: isStore('SelectedChannelStore'),
    AuthenticationStore: isStore('AuthenticationStore'),
    // Profiles: the store the client's profile reads, the fetch a click on someone runs (and, under it, the fetch
    // itself, from a module that also accepts the terms of service: only the fetch is ever taken from it), the
    // connected-account table, and presences for the custom status.
    UserProfileStore: isStore('UserProfileStore'),
    PresenceStore: isStore('PresenceStore'),
    ProfileOpen: (m) => !!exportedFn(m, 2, isProfileOpen),
    ProfileFetch: (m) => !!exportedFn(m, 12, isProfileFetch),
    Platforms: (m) => typeof m.get === 'function' && typeof m.getByUrl === 'function' && typeof m.isSupported === 'function',
  };
  // Nothing works without these; the others only degrade features.
  const CORE = ['Dispatcher', 'UserStore', 'ChannelStore', 'GuildStore'];
  const mod = {};

  /** One pass over every module, filling in whatever `mod` still lacks. */
  function resolveModules() {
    const missing = Object.keys(FINDERS).filter((k) => !mod[k]);
    if (missing.length) {
      for (const m of candidates()) {
        for (let i = missing.length - 1; i >= 0; i--) {
          let hit = false;
          try {
            hit = FINDERS[missing[i]](m);
          } catch (e) {
            /* some getters throw */
          }
          if (hit) mod[missing.splice(i, 1)[0]] = m;
        }
        if (!missing.length) break;
      }
    }
    const results = {};
    for (const k of Object.keys(FINDERS)) results[k] = !!mod[k];
    return results;
  }

  // The stores exist only once the app's own modules have run, so keep looking
  // until the core ones resolve. Success is reported at once, failure only after
  // a grace period (the adapter turns it into a "client changed" card).
  const startedAt = Date.now();
  let coreReady = false;
  let lastReport = '';
  function report(results) {
    const key = JSON.stringify(results);
    if (key === lastReport) return;
    lastReport = key;
    up({ t: 'finders', results, detail: `runtimes=${requires.size} modules=${moduleCount()}` });
  }
  function resolveTick() {
    const results = resolveModules();
    const age = Date.now() - startedAt;
    if (CORE.every((k) => results[k])) {
      report(results);
      if (!coreReady) {
        coreReady = true;
        subscribeDispatch();
      }
      // Optional modules can arrive with later chunks; stop looking after a while.
      if (!Object.values(results).every(Boolean) && age < 5 * 60_000) setTimeout(resolveTick, 5000);
      return;
    }
    if (age > 90_000) report(results);
    setTimeout(resolveTick, age > 120_000 ? 10_000 : 1000);
  }
  function currentUser() {
    try {
      return mod.UserStore && mod.UserStore.getCurrentUser();
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- whitelisting
  const pickUser = (u) => u && { id: u.id, username: u.username, global_name: u.globalName ?? u.global_name ?? null, discriminator: u.discriminator, avatar: u.avatar, bot: !!u.bot };
  const pickChannel = (c) =>
    c && {
      id: c.id,
      type: c.type,
      guild_id: c.guild_id ?? c.guildId ?? null,
      name: c.name ?? null,
      topic: c.topic ?? null,
      position: c.position,
      parent_id: c.parent_id ?? c.parentId ?? null,
      recipients: Array.isArray(c.recipients) ? c.recipients.map((r) => (typeof r === 'string' ? resolveUser(r) : pickUser(r))).filter(Boolean) : undefined,
      owner_id: c.ownerId ?? c.owner_id ?? null,
      icon: c.icon ?? null,
      thread_metadata: c.threadMetadata ? { archived: !!c.threadMetadata.archived, locked: !!c.threadMetadata.locked } : c.thread_metadata,
      last_message_id: c.lastMessageId ?? c.last_message_id ?? null,
    };
  const pickGuild = (g) => g && { id: g.id, name: g.name, icon: g.icon, description: g.description ?? null, rules_channel_id: g.rulesChannelId ?? g.rules_channel_id ?? null };
  const pickEmoji = (e) => e && { id: e.id ?? null, name: e.name ?? null, animated: !!e.animated };
  const pickAttachment = (a) => a && { id: a.id, filename: a.filename, content_type: a.content_type, size: a.size, width: a.width, height: a.height, url: a.url, proxy_url: a.proxy_url };
  // Discord's own proxy for embed images when there is one: the hub fetches these, and must not hit whatever host a message names.
  const pickEmbedImage = (i) => i && { url: i.proxy_url ?? i.proxyURL ?? i.url };
  const pickEmbed = (e) =>
    e && {
      type: e.type,
      title: e.rawTitle ?? e.title,
      description: e.rawDescription ?? e.description,
      url: e.url,
      provider: e.provider && { name: e.provider.name },
      author: e.author && { name: e.author.name },
      fields: Array.isArray(e.fields) ? e.fields.map((f) => ({ name: f.rawName ?? f.name, value: f.rawValue ?? f.value })) : undefined,
      thumbnail: pickEmbedImage(e.thumbnail),
      image: pickEmbedImage(e.image),
    };
  function pickMessage(m) {
    if (!m) return null;
    return {
      id: m.id,
      channel_id: m.channel_id ?? m.channelId,
      guild_id: m.guild_id ?? m.guildId ?? null,
      author: pickUser(m.author),
      content: m.content ?? '',
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : m.timestamp && m.timestamp.toISOString ? m.timestamp.toISOString() : new Date().toISOString(),
      edited_timestamp: m.edited_timestamp ?? (m.editedTimestamp && m.editedTimestamp.toISOString ? m.editedTimestamp.toISOString() : m.editedTimestamp) ?? null,
      type: m.type,
      mention_everyone: !!(m.mention_everyone ?? m.mentionEveryone),
      mentions: Array.isArray(m.mentions) ? m.mentions.map((u) => (typeof u === 'string' ? resolveUser(u) : pickUser(u))).filter(Boolean) : undefined,
      attachments: Array.isArray(m.attachments) ? m.attachments.map(pickAttachment) : undefined,
      embeds: Array.isArray(m.embeds) ? m.embeds.map(pickEmbed) : undefined,
      reactions: Array.isArray(m.reactions)
        ? m.reactions.map((r) => ({ emoji: pickEmoji(r.emoji), count: r.count, count_details: r.count_details, burst_count: r.burst_count, me: !!r.me, me_burst: !!r.me_burst, burst_colors: r.burst_colors }))
        : undefined,
      message_reference: m.message_reference ?? (m.messageReference ? { message_id: m.messageReference.messageId ?? m.messageReference.message_id, channel_id: m.messageReference.channelId ?? m.messageReference.channel_id, guild_id: m.messageReference.guildId ?? m.messageReference.guild_id, type: m.messageReference.type } : undefined),
      thread: m.thread ? pickChannel(m.thread) : undefined,
      message_snapshots: pickSnapshots(m.message_snapshots ?? m.messageSnapshots),
      sticker_items: Array.isArray(m.sticker_items) ? m.sticker_items.map((s) => ({ name: s.name })) : undefined,
      poll: m.poll && m.poll.question ? { question: m.poll.question.text, answers: (m.poll.answers ?? []).map((a) => a.poll_media && a.poll_media.text).filter(Boolean) } : undefined,
    };
  }
  // A forward's content. Records in the client's stores use camelCase and Date timestamps.
  function pickSnapshots(list) {
    if (!Array.isArray(list)) return undefined;
    return list
      .map((s) => {
        const x = s && s.message;
        if (!x) return null;
        const ts = x.timestamp && x.timestamp.toISOString ? x.timestamp.toISOString() : typeof x.timestamp === 'string' ? x.timestamp : undefined;
        return { content: x.content ?? '', timestamp: ts, attachments: (x.attachments ?? []).map(pickAttachment), embeds: (x.embeds ?? []).map(pickEmbed) };
      })
      .filter(Boolean);
  }
  function nickOf(guildId, userId) {
    try {
      return (guildId && mod.GuildMemberStore && mod.GuildMemberStore.getNick(guildId, userId)) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * You are typing, or stopped: the client's own typing action, as its composer calls it on a keystroke, so the request,
   * its throttle and its local state are the client's. Without that module, the action it dispatches.
   */
  function typing(channelId, stop) {
    const t = mod.TypingActions;
    if (t) {
      if (stop) t.stopTyping(channelId);
      else t.startTyping(channelId);
      return { ok: true, via: 'actions' };
    }
    mod.Dispatcher.dispatch({ type: stop ? 'TYPING_STOP_LOCAL' : 'TYPING_START_LOCAL', channelId });
    return { ok: true, via: 'dispatch' };
  }

  function resolveUser(id) {
    try {
      return pickUser(mod.UserStore.getUser(id));
    } catch (e) {
      return { id };
    }
  }

  // ---------------------------------------------------------------- snapshot
  let snapshotSent = false;
  function buildSnapshot() {
    const data = {};
    const users = new Map();
    const addUser = (u) => {
      if (u && u.id && !users.has(u.id)) users.set(u.id, u);
    };
    try {
      const me = mod.UserStore && mod.UserStore.getCurrentUser();
      if (me) data.self = pickUser(me);
    } catch (e) {}
    try {
      const guilds = mod.GuildStore ? mod.GuildStore.getGuilds() : {};
      data.guilds = Object.values(guilds).map(pickGuild).filter(Boolean);
      const channels = [];
      for (const gid of Object.keys(guilds)) {
        const list = guildChannels(gid);
        for (const c of list) channels.push(c);
      }
      data.channels = channels;
    } catch (e) {
      log('warn', 'guild/channel snapshot failed', String(e));
    }
    try {
      data.threads = activeThreads();
    } catch (e) {}
    try {
      const priv = mod.ChannelStore && (mod.ChannelStore.getMutablePrivateChannels ? mod.ChannelStore.getMutablePrivateChannels() : null);
      const list = priv ? Object.values(priv) : getSortedPrivate();
      data.privateChannels = list.map(pickChannel).filter(Boolean);
      for (const c of list) if (Array.isArray(c.recipients)) for (const r of c.recipients) addUser(typeof r === 'string' ? resolveUser(r) : pickUser(r));
    } catch (e) {
      log('warn', 'private channel snapshot failed', String(e));
    }
    try {
      // getRelationships() is gone from current clients; relationshipTypes() reads whichever shape this build has.
      if (mod.RelationshipStore) {
        const types = relationshipTypes();
        data.relationships = Array.from(types, ([id, type]) => ({ id, type }));
        for (const id of types.keys()) addUser(resolveUser(id));
      }
    } catch (e) {}
    try {
      data.readStates = readStates();
    } catch (e) {}
    try {
      data.guildSettings = guildSettings();
    } catch (e) {}
    data.users = Array.from(users.values());
    return data;
  }

  function guildChannels(gid) {
    const out = [];
    const gcs = mod.GuildChannelStore;
    if (gcs && gcs.getChannels) {
      const g = gcs.getChannels(gid);
      if (g) {
        for (const key of Object.keys(g)) {
          const bucket = g[key];
          if (Array.isArray(bucket)) for (const entry of bucket) if (entry && entry.channel) out.push(pickChannel(entry.channel));
        }
      }
    }
    if (!out.length && mod.ChannelStore && mod.ChannelStore.getMutableGuildChannelsForGuild) {
      const map = mod.ChannelStore.getMutableGuildChannelsForGuild(gid) || {};
      for (const c of Object.values(map)) out.push(pickChannel(c));
    }
    return out.filter(Boolean);
  }
  function activeThreads() {
    const out = [];
    const ts = mod.ThreadStore;
    try {
      if (ts && ts.getActiveUnjoinedThreadsForGuild) return out; // handled lazily elsewhere
    } catch (e) {}
    return out;
  }
  function getSortedPrivate() {
    try {
      return mod.ChannelStore.getSortedPrivateChannels ? mod.ChannelStore.getSortedPrivateChannels() : [];
    } catch (e) {
      return [];
    }
  }
  function readStates() {
    const rss = mod.ReadStateStore;
    if (!rss) return [];
    try {
      if (rss.getAllReadStates) {
        const all = rss.getAllReadStates();
        const arr = Array.isArray(all) ? all : Object.values(all || {});
        return arr.map((r) => ({ id: r.channelId ?? r.id, last_message_id: r.lastMessageId ?? r.last_message_id ?? null, mention_count: r.mentionCount ?? r._mentionCount ?? 0 })).filter((r) => r.id);
      }
    } catch (e) {}
    return [];
  }
  function guildSettings() {
    const gs = mod.UserGuildSettingsStore;
    if (!gs) return [];
    try {
      const all = gs.getAllSettings ? gs.getAllSettings() : null;
      if (all) return normalizeGuildSettings(all);
    } catch (e) {}
    return [];
  }
  function normalizeGuildSettings(all) {
    const list = [];
    const src = all.userGuildSettings || all;
    const entries = Array.isArray(src) ? src : Object.values(src || {});
    for (const s of entries) {
      if (!s) continue;
      list.push({
        guild_id: s.guildId ?? s.guild_id ?? null,
        muted: !!s.muted,
        mute_config: s.muteConfig ? { end_time: s.muteConfig.endTime ?? s.muteConfig.end_time ?? null } : null,
        message_notifications: s.messageNotifications ?? s.message_notifications,
        channel_overrides: Array.isArray(s.channelOverrides || s.channel_overrides)
          ? (s.channelOverrides || s.channel_overrides).map((o) => ({ channel_id: o.channelId ?? o.channel_id, muted: !!o.muted, mute_config: o.muteConfig ? { end_time: o.muteConfig.endTime ?? null } : null, message_notifications: o.messageNotifications ?? o.message_notifications }))
          : [],
      });
    }
    return list;
  }

  function maybeSendSnapshot(reason) {
    if (!coreReady) return;
    const data = buildSnapshot();
    snapshotSent = true;
    up({ t: 'snapshot', data });
    log('info', 'snapshot sent (' + reason + ')', { guilds: (data.guilds || []).length, channels: (data.channels || []).length, dms: (data.privateChannels || []).length });
  }

  // ----------------------------------------------------------- dispatch relay
  const FORWARD = [
    'MESSAGE_CREATE',
    'MESSAGE_UPDATE',
    'MESSAGE_DELETE',
    'MESSAGE_REACTION_ADD',
    'MESSAGE_REACTION_REMOVE',
    'MESSAGE_REACTION_REMOVE_ALL',
    'MESSAGE_REACTION_REMOVE_EMOJI',
    'CHANNEL_CREATE',
    'CHANNEL_UPDATES',
    'CHANNEL_DELETE',
    'GUILD_CREATE',
    'GUILD_UPDATE',
    'GUILD_DELETE',
    'THREAD_CREATE',
    'THREAD_UPDATE',
    'THREAD_DELETE',
    'THREAD_LIST_SYNC',
    'MESSAGE_ACK',
    'TYPING_START',
  ];
  function subscribeDispatch() {
    const d = mod.Dispatcher;
    if (!d) return;
    const handler = (event) => (action) => {
      try {
        up({ t: 'dispatch', event, data: shrink(event, action) });
      } catch (e) {
        /* ignore */
      }
    };
    for (const ev of FORWARD) {
      try {
        d.subscribe(ev, handler(ev));
      } catch (e) {
        log('warn', 'subscribe failed for ' + ev, String(e));
      }
    }
    try {
      d.subscribe('CONNECTION_OPEN', () => maybeSendSnapshot('CONNECTION_OPEN'));
    } catch (e) {}
    log('info', 'subscribed to ' + FORWARD.length + ' dispatch events');
  }

  // Keep only the whitelisted shape of each forwarded action.
  function shrink(event, a) {
    switch (event) {
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE':
        return { message: pickMessage(a.message), optimistic: a.optimistic, channelId: a.channelId };
      case 'MESSAGE_DELETE':
        return { id: a.id, channelId: a.channelId, guildId: a.guildId };
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE':
        return { channelId: a.channelId, messageId: a.messageId, userId: a.userId, user: resolveUser(a.userId), emoji: pickEmoji(a.emoji), optimistic: !!a.optimistic, colors: a.colors, reactionType: a.reactionType };
      case 'MESSAGE_REACTION_REMOVE_ALL':
      case 'MESSAGE_REACTION_REMOVE_EMOJI':
        return { channelId: a.channelId, messageId: a.messageId, emoji: pickEmoji(a.emoji) };
      case 'CHANNEL_UPDATES':
        return { channels: Array.isArray(a.channels) ? a.channels.map(pickChannel) : [] };
      case 'CHANNEL_CREATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        return { channel: pickChannel(a.channel) };
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        return { channel: pickChannel(a.channel) || { id: a.id, guild_id: a.guildId } };
      case 'GUILD_CREATE':
        return { guild: pickGuild(a.guild) };
      case 'GUILD_UPDATE':
        return { guild: pickGuild(a.guild) };
      case 'GUILD_DELETE':
        return { id: a.guild ? a.guild.id : a.id };
      case 'THREAD_LIST_SYNC':
        return { guildId: a.guildId, threads: Array.isArray(a.threads) ? a.threads.map(pickChannel) : [] };
      case 'MESSAGE_ACK':
        return { channelId: a.channelId, messageId: a.messageId, mentionCount: a.mentionCount };
      case 'TYPING_START':
        return { channelId: a.channelId, userId: a.userId, user: resolveUser(a.userId), nick: nickOf(a.guildId, a.userId) };
      default:
        return {};
    }
  }

  // --------------------------------------------------------------- commands
  /** Set only in lab sandboxes (src/lab/lab.js, appended at the marker below). */
  let labCommand = null;
  async function runCommand(cmd) {
    if (!coreReady) throw new Error('the Discord client has not finished loading');
    switch (cmd.kind) {
      case 'send':
        return sendMessage(cmd);
      case 'forward':
        return forwardMessage(cmd);
      case 'openDirect':
        return openDirect(cmd.userId);
      case 'history':
        return history(cmd);
      case 'markRead':
        return rest('post', `/channels/${cmd.channelId}/messages/${cmd.messageId}/ack`, undefined, { token: null });
      case 'typing':
        return typing(cmd.channelId, !!cmd.stop);
      case 'react': {
        const url = `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions/${encodeURIComponent(cmd.emoji)}`;
        const type = cmd.burst ? 1 : 0;
        if (cmd.remove) await rest('del', `${url}/${type}/@me`, { location: 'Message', burst: !!cmd.burst });
        else await rest('put', `${url}/@me`, { location: 'Message', type });
        return { ok: true };
      }
      case 'reactors': {
        const url = `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions/${encodeURIComponent(cmd.emoji)}`;
        const res = await rest('get', url, { limit: 100, type: cmd.burst ? 1 : 0 });
        return { users: ((res && res.body) || []).map(pickUser).filter(Boolean) };
      }
      case 'reactionContext':
        return reactionContext(cmd.channelId);
      case 'about':
        return about(cmd);
      case 'configure':
        return configure(cmd);
      case 'profile':
        return profile(cmd);
      case 'edit':
        if (mod.MessageActions && mod.MessageActions.editMessage) return mod.MessageActions.editMessage(cmd.channelId, cmd.messageId, { content: cmd.content }), { ok: true };
        return rest('patch', `/channels/${cmd.channelId}/messages/${cmd.messageId}`, undefined, { content: cmd.content });
      case 'call':
        return callCommand(cmd);
      case 'lab':
        if (!labCommand) throw new Error('not a lab sandbox');
        return labCommand(cmd);
      case 'redact':
        if (mod.MessageActions && mod.MessageActions.deleteMessage) return mod.MessageActions.deleteMessage(cmd.channelId, cmd.messageId), { ok: true };
        return rest('del', `/channels/${cmd.channelId}/messages/${cmd.messageId}`);
      default:
        throw new Error('unknown command ' + cmd.kind);
    }
  }


  // ------------------------------------------------------------------ calls
  // Bridge mode: the client joins the call itself, exactly as its own button would, and handles
  // the call's media and encryption. Its remote audio is mixed and sent to the device over a
  // second peer connection, and the device's microphone comes back over it and is what the
  // client gets from getUserMedia. Patches exist only while a bridge call does.
  const call = { id: null, mode: null, channelId: null, pc: null, ctx: null, mix: null, mic: null, mixMeter: null, micMeter: null, micSrc: null, unpatch: null, unsub: null, timer: null, joinedAt: 0 };
  const ourPCs = new WeakSet();
  const tapped = new WeakSet();

  function callUp(extra) {
    up({ t: 'call', call: call.id, ...extra });
  }

  async function callCommand(cmd) {
    if (cmd.op === 'join') return callJoin(cmd);
    if (cmd.call !== call.id) return { stale: true };
    if (cmd.op === 'leave') return callLeave(false);
    if (cmd.op === 'mute') return callMute(cmd.muted, cmd.deafened);
    if (cmd.op === 'signal') return bridgeSignal(cmd.data);
    return { ok: true };
  }

  async function callJoin(cmd) {
    if (call.id) await callLeave(false);
    if (!mod.VoiceActions) throw new Error('the client has no voice module (Discord changed?)');
    const channel = mod.ChannelStore.getChannel(cmd.channelId);
    if (!channel) throw new Error('unknown channel');
    if (cmd.mode === 'direct') return directJoin(cmd, channel);
    if (cmd.mode !== 'bridge') throw new Error('unknown call mode');
    Object.assign(call, { id: cmd.call, mode: cmd.mode, channelId: cmd.channelId, joinedAt: Date.now() });
    // The audio graph runs only to feed the bridge; nothing plays in the sandbox.
    call.ctx = new AudioContext({ latencyHint: 'interactive' });
    call.mix = call.ctx.createMediaStreamDestination();
    call.mic = call.ctx.createMediaStreamDestination();
    call.mixMeter = call.ctx.createAnalyser();
    call.micMeter = call.ctx.createAnalyser();
    call.unpatch = patchMedia();
    call.unsub = watchCall();
    mod.VoiceActions.selectVoiceChannel(cmd.channelId);
    if (cmd.muted || cmd.deafened) setTimeout(() => callMute(!!cmd.muted, !!cmd.deafened), 500);
    return {};
  }

  async function callLeave(fromClient) {
    if (!call.id) return { ok: true };
    const id = call.id;
    const wasDirect = call.mode === 'direct';
    try {
      if (!fromClient && mod.SelectedChannelStore && mod.SelectedChannelStore.getVoiceChannelId() === call.channelId) mod.VoiceActions.disconnect();
    } catch (e) {
      log('warn', 'disconnect failed', String(e));
    }
    try {
      call.pc && call.pc.close();
    } catch (e) {}
    try {
      call.ctx && call.ctx.close();
    } catch (e) {}
    try {
      call.unpatch && call.unpatch();
      call.unsub && call.unsub();
    } catch (e) {}
    clearInterval(call.timer);
    // Any voice server handed out from here on is the page's again.
    if (wasDirect) setTimeout(() => (external.active = false), 3000);
    if (fromClient) up({ t: 'call', call: id, ended: fromClient });
    Object.assign(call, { id: null, mode: null, channelId: null, pc: null, ctx: null, mix: null, mic: null, mixMeter: null, micMeter: null, micSrc: null, unpatch: null, unsub: null, timer: null });
    return { ok: true };
  }

  function callMute(muted, deafened) {
    const me = mod.MediaEngineStore;
    const act = mod.AudioActions;
    if (!me || !act) throw new Error('the client has no audio settings module');
    if (!!me.isSelfDeaf() !== !!deafened) act.toggleSelfDeaf();
    // Undeafening restores the previous mute, so read it again.
    if (!!me.isSelfMute() !== !!muted) act.toggleSelfMute();
    return { ok: true };
  }

  /** Participants from the client's own stores, pushed whenever they change (at most every 150 ms). */
  function watchCall() {
    let queued = false;
    let last = '';
    const push = () => {
      queued = false;
      if (!call.id) return;
      const users = [];
      const participants = [];
      let states = {};
      try {
        states = mod.VoiceStateStore.getVoiceStatesForChannel(call.channelId) || {};
      } catch (e) {}
      for (const v of Object.values(states)) {
        const id = v.userId || v.user_id;
        if (!id) continue;
        let speaking = false;
        try {
          speaking = !!(mod.SpeakingStore && mod.SpeakingStore.isSpeaking(id));
        } catch (e) {}
        participants.push({ id, muted: !!(v.selfMute || v.mute), deafened: !!(v.selfDeaf || v.deaf), speaking, video: !!v.selfVideo });
        users.push(resolveUser(id));
      }
      const key = JSON.stringify(participants);
      if (key === last) return;
      last = key;
      callUp({ state: { channelId: call.channelId, participants }, users: users.filter((u) => u && u.username) });
    };
    const onChange = () => {
      if (!queued) {
        queued = true;
        setTimeout(push, 150);
      }
      // The call ended from the client's side: kicked, moved, or the channel went away.
      try {
        const now = mod.SelectedChannelStore && mod.SelectedChannelStore.getVoiceChannelId();
        if (call.id && Date.now() - call.joinedAt > 5000 && now !== call.channelId) void callLeave(now ? 'moved to another channel' : 'disconnected');
      } catch (e) {}
    };
    const stores = [mod.VoiceStateStore, mod.SpeakingStore, mod.SelectedChannelStore].filter(Boolean);
    for (const st of stores) st.addChangeListener(onChange);
    onChange();
    // What the client's own voice connection is doing, for the adapter log (and comparing the modes).
    call.timer = setInterval(() => void logRtc(), 10_000);
    return () => stores.forEach((st) => st.removeChangeListener(onChange));
  }


  // Direct mode: the device speaks the voice protocol itself. The page joins the channel exactly as
  // its own button would (so the gateway's voice state, mute flags and the participant list stay the
  // client's), but the voice server Discord hands out goes to the device, and the page never sees
  // it: one Dispatcher interceptor swallows VOICE_SERVER_UPDATE, so the page's own connection waits
  // for an endpoint that never comes. The voice token is scoped to this one connection; the account's
  // login token stays here.
  const external = { active: false, channelId: null, guildId: null, waiter: null };
  let interceptor = false;
  function installInterceptor() {
    if (interceptor) return true;
    const d = mod.Dispatcher;
    if (!d || typeof d.addInterceptor !== 'function') return false;
    d.addInterceptor((action) => {
      try {
        if (!external.active || !action || action.type !== 'VOICE_SERVER_UPDATE') return false;
        const ours = external.guildId ? action.guildId === external.guildId : !action.guildId && (!action.channelId || action.channelId === external.channelId);
        if (!ours) return false;
        // A null endpoint means the server is still being allocated; another update follows.
        if (action.endpoint) voiceServer(action.endpoint, action.token);
        return true;
      } catch (e) {
        return false;
      }
    });
    interceptor = true;
    return true;
  }

  function voiceServer(endpoint, token) {
    if (external.waiter) {
      const w = external.waiter;
      external.waiter = null;
      w({ endpoint, token });
    } else if (call.id && call.mode === 'direct') {
      // The voice server moved: the device reconnects to the new one.
      callUp({ signal: { kind: 'voice-server', endpoint, token } });
    }
  }

  async function directJoin(cmd, channel) {
    if (!installInterceptor()) throw new Error('the client has no dispatcher interceptor (Discord changed?)');
    const me = currentUser();
    let sessionId = null;
    try {
      sessionId = mod.AuthenticationStore && mod.AuthenticationStore.getSessionId();
    } catch (e) {}
    if (!me || !sessionId) throw new Error('the client has no gateway session yet');
    const guildId = channel.guild_id || (channel.getGuildId && channel.getGuildId()) || null;
    Object.assign(external, { active: true, channelId: cmd.channelId, guildId });
    Object.assign(call, { id: cmd.call, mode: 'direct', channelId: cmd.channelId, joinedAt: Date.now() });
    call.unsub = watchCall();
    let server;
    try {
      server = await new Promise((resolve, reject) => {
        external.waiter = resolve;
        setTimeout(() => reject(new Error('Discord gave no voice server within 20 s')), 20_000);
        mod.VoiceActions.selectVoiceChannel(cmd.channelId);
      });
    } catch (e) {
      external.waiter = null;
      await callLeave(false);
      throw e;
    }
    if (cmd.muted || cmd.deafened) setTimeout(() => callMute(!!cmd.muted, !!cmd.deafened), 200);
    return { direct: { network: 'discord', endpoint: server.endpoint, token: server.token, serverId: guildId || cmd.channelId, channelId: cmd.channelId, userId: me.id, sessionId } };
  }

  /** While a bridge call runs: the client's microphone is the device's, and its peer connections are tapped for remote audio. */
  function patchMedia() {
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia;
    const enumerate = md.enumerateDevices;
    const srd = RTCPeerConnection.prototype.setRemoteDescription;
    md.getUserMedia = function (constraints) {
      if (!call.id || !constraints || !constraints.audio || constraints.video) return gum.apply(this, arguments);
      log('debug', 'the client asked for the microphone; it gets the device\'s');
      return Promise.resolve(new MediaStream([call.mic.stream.getAudioTracks()[0].clone()]));
    };
    // With no sound card the list is empty, and the client then refuses to join with a microphone.
    md.enumerateDevices = function () {
      return enumerate.apply(this, arguments).then((list) =>
        list.some((d) => d.kind === 'audioinput')
          ? list
          : [...list, { deviceId: 'default', groupId: 'dither', kind: 'audioinput', label: 'Default', toJSON() { return { deviceId: 'default', groupId: 'dither', kind: 'audioinput', label: 'Default' }; } }],
      );
    };
    RTCPeerConnection.prototype.setRemoteDescription = function () {
      if (!ourPCs.has(this)) tapPC(this);
      return srd.apply(this, arguments);
    };
    return () => {
      md.getUserMedia = gum;
      md.enumerateDevices = enumerate;
      RTCPeerConnection.prototype.setRemoteDescription = srd;
    };
  }

  const discordPCs = new Set();
  function tapPC(pc) {
    if (tapped.has(pc)) return;
    tapped.add(pc);
    discordPCs.add(pc);
    pc.addEventListener('track', (e) => mixIn(e.track));
    for (const r of pc.getReceivers()) if (r.track) mixIn(r.track);
  }

  async function logRtc() {
    const out = [];
    for (const pc of discordPCs) {
      if (pc.connectionState === 'closed') {
        discordPCs.delete(pc);
        continue;
      }
      let sent = 0;
      let received = 0;
      let level = null;
      let rtp = 0;
      try {
        (await pc.getStats()).forEach((r) => {
          if (r.type === 'transport') {
            sent += r.bytesSent || 0;
            received += r.bytesReceived || 0;
          }
          if (r.type === 'media-source' && r.kind === 'audio') level = r.audioLevel;
          if (r.type === 'outbound-rtp' && r.kind === 'audio') rtp += r.bytesSent || 0;
        });
      } catch (e) {}
      let senders = [];
      try {
        senders = pc.getTransceivers().map((t) => ({ dir: t.currentDirection, kind: t.sender.track && t.sender.track.kind, en: t.sender.track && t.sender.track.enabled, rs: t.sender.track && t.sender.track.readyState, act: (t.sender.getParameters().encodings || []).map((e) => e.active), tf: t.sender.transform ? t.sender.transform.constructor.name : null, codecs: (t.sender.getParameters().codecs || []).map((c) => c.mimeType).slice(0, 3) }));
        senders.push({ api: { ces: typeof RTCRtpSender.prototype.createEncodedStreams, rst: typeof window.RTCRtpScriptTransform, cfg: JSON.stringify(pc.getConfiguration()).slice(0, 300) } });
      } catch (e) {}
      out.push({ state: pc.connectionState, sent, received, rtp, level, senders });
    }
    const me = currentUser();
    let self = {};
    try {
      const m = mod.MediaEngineStore;
      self = { mute: m.isSelfMute(), deaf: m.isSelfDeaf(), mode: m.getMode && m.getMode(), speaking: !!(me && mod.SpeakingStore.isSpeaking(me.id)) };
    } catch (e) {}
    log('info', 'call rtc', { self, discord: out, bridge: call.pc ? call.pc.connectionState : null, ctx: call.ctx && call.ctx.state, mic: rms(call.micMeter), mix: rms(call.mixMeter) });
  }

  function rms(an) {
    if (!an) return null;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.round(Math.sqrt(sum / buf.length) * 1000) / 1000;
  }

  // Chrome only feeds a remote track into Web Audio while a media element also plays it.
  const sinks = new WeakMap();
  function mixIn(track) {
    if (!call.ctx || track.kind !== 'audio' || sinks.has(track)) return;
    const stream = new MediaStream([track]);
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = call.ctx.createMediaStreamSource(stream);
    src.connect(call.mix);
    src.connect(call.mixMeter);
    sinks.set(track, { el, src });
    track.addEventListener('ended', () => {
      try {
        src.disconnect();
      } catch (e) {}
      el.srcObject = null;
    });
  }

  /** The device offers; the sandbox answers with the mix and takes the device's microphone. */
  async function bridgeSignal(data) {
    if (call.mode !== 'bridge') return { ignored: true };
    if (data && data.sdp && data.type === 'offer') {
      if (call.pc) call.pc.close();
      const pc = new RTCPeerConnection({ iceServers: data.iceServers || [] });
      ourPCs.add(pc);
      call.pc = pc;
      pc.onicecandidate = (e) => callUp({ signal: { candidate: e.candidate ? e.candidate.toJSON() : null } });
      pc.ontrack = (e) => {
        if (e.track.kind !== 'audio') return;
        const stream = new MediaStream([e.track]);
        const el = new Audio();
        el.muted = true;
        el.srcObject = stream;
        el.play().catch(() => {});
        try {
          call.micSrc && call.micSrc.disconnect();
        } catch (err) {}
        call.micSrc = call.ctx.createMediaStreamSource(stream);
        call.micSrc.connect(call.mic);
        call.micSrc.connect(call.micMeter);
      };
      pc.onconnectionstatechange = () => log('info', 'bridge ' + pc.connectionState);
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      const t = pc.getTransceivers().find((x) => x.receiver.track && x.receiver.track.kind === 'audio');
      const mixTrack = call.mix.stream.getAudioTracks()[0];
      if (t) {
        t.direction = 'sendrecv';
        await t.sender.replaceTrack(mixTrack);
      } else pc.addTrack(mixTrack, call.mix.stream);
      await pc.setLocalDescription(await pc.createAnswer());
      callUp({ signal: { type: 'answer', sdp: pc.localDescription.sdp } });
      return { ok: true };
    }
    if (data && 'candidate' in data && call.pc) {
      if (data.candidate) await call.pc.addIceCandidate(data.candidate).catch((e) => log('debug', 'candidate refused', String(e)));
      return { ok: true };
    }
    return { ignored: true };
  }

  // ---------------------------------------------------------------- reacting
  const PERM_ADD_REACTIONS = 1n << 6n;
  const PERM_READ_HISTORY = 1n << 16n;
  const EMOJI_INTENT_REACTION = 0;

  function reactionContext(channelId) {
    const channel = mod.ChannelStore.getChannel(channelId);
    const guildId = (channel && (channel.guild_id ?? channel.getGuildId?.())) || null;
    const can = (bit) => {
      try {
        return !guildId || !mod.PermissionStore || mod.PermissionStore.can(bit, channel);
      } catch (e) {
        return true;
      }
    };
    const canRead = can(PERM_READ_HISTORY);
    const nitro = ((currentUser() && currentUser().premiumType) || 0) > 0;
    return {
      canReact: canRead,
      reason: canRead ? undefined : 'You cannot read message history in this channel, which reacting needs.',
      existingOnly: !can(PERM_ADD_REACTIONS),
      custom: customEmojiGroups(channel, guildId, nitro),
      nitro,
    };
  }

  function customEmojiGroups(channel, guildId, nitro) {
    const store = mod.EmojiStore;
    if (!store) return [];
    const usable = (e) => {
      try {
        if (mod.EmojiRules) return mod.EmojiRules.getEmojiUnavailableReason({ emoji: e, channel, intention: EMOJI_INTENT_REACTION }) == null;
      } catch (err) {
        /* fall through to the plain rule */
      }
      return e.available !== false && (nitro || (e.guildId === guildId && !e.animated));
    };
    const ids = Object.keys(store.getGuilds() || {}).sort((a, b) => (b === guildId) - (a === guildId));
    const groups = [];
    for (const id of ids) {
      const emoji = (store.getGuildEmoji(id) || []).filter(usable).map((e) => ({ id: e.id, name: e.name, animated: !!e.animated }));
      if (!emoji.length) continue;
      const guild = mod.GuildStore.getGuild(id);
      groups.push({ guild: pickGuild(guild) || { id, name: 'Server' }, here: id === guildId, emoji });
    }
    return groups;
  }

  // ------------------------------------------------------- about and settings
  // Read from the client's stores alone, so it costs no request. Permissions fail closed: null when the client
  // cannot say, and the adapter offers nothing it was not told yes to (reactionContext fails open on purpose).
  const PERM = {
    createInvite: 1n << 0n,
    manageChannels: 1n << 4n,
    manageGuild: 1n << 5n,
    sendMessages: 1n << 11n,
    manageMessages: 1n << 13n,
    manageRoles: 1n << 28n,
    manageThreads: 1n << 34n,
    pinMessages: 1n << 51n,
  };
  const MEMBER_CAP = 200;
  const CATEGORY = 4;
  const ANNOUNCEMENT = 5;
  const THREAD_TYPES = [10, 11, 12];

  function canAll(subject) {
    const out = {};
    const ps = mod.PermissionStore;
    for (const k of Object.keys(PERM)) {
      let v = null;
      try {
        if (subject && ps && typeof ps.can === 'function') v = ps.can(PERM[k], subject) === true;
      } catch (e) {
        v = null;
      }
      out[k] = v;
    }
    return out;
  }

  /** Whether the @everyone overwrite (its id is the guild's) denies a permission. Store records keep a map, raw ones a list. */
  function everyoneDenies(c, guildId, bit) {
    const ow = c && (c.permissionOverwrites ?? c.permission_overwrites);
    const list = Array.isArray(ow) ? ow : Object.values(ow || {});
    const o = list.find((x) => x && x.id === guildId);
    if (!o || o.deny == null) return false;
    try {
      return (BigInt(String(o.deny)) & bit) !== 0n;
    } catch (e) {
      return false;
    }
  }

  function pickAboutChannel(c) {
    const base = pickChannel(c);
    const guildId = base.guild_id;
    let nsfw = c.nsfw ?? c.nsfw_;
    if (nsfw === undefined && typeof c.isNSFW === 'function') {
      try {
        nsfw = c.isNSFW();
      } catch (e) {}
    }
    // A thread sends by its parent's overwrites.
    const parent = THREAD_TYPES.includes(c.type) && base.parent_id ? mod.ChannelStore.getChannel(base.parent_id) : null;
    return {
      ...base,
      nsfw: !!nsfw,
      rate_limit_per_user: Number(c.rateLimitPerUser ?? c.rate_limit_per_user ?? 0) || 0,
      everyone_denies_send: !!guildId && (c.type === ANNOUNCEMENT || everyoneDenies(parent || c, guildId, PERM.sendMessages)),
    };
  }
  function pickAboutGuild(g) {
    const ownerId = g.ownerId ?? g.owner_id ?? null;
    const features = g.features;
    const has = (f) => !!features && (typeof features.has === 'function' ? features.has(f) : Array.isArray(features) && features.includes(f));
    return {
      ...pickGuild(g),
      owner_id: ownerId,
      owner: ownerId ? resolveUser(ownerId) || null : null,
      verification_level: g.verificationLevel ?? g.verification_level ?? null,
      nsfw_level: g.nsfwLevel ?? g.nsfw_level ?? null,
      community: has('COMMUNITY'),
    };
  }

  const hexColor = (n) => (typeof n === 'number' && n > 0 ? '#' + n.toString(16).padStart(6, '0') : null);
  const pickRole = (r) => ({ id: r.id, name: r.name, color: r.colorString || hexColor(r.color) || null, position: Number(r.position) || 0, hoist: !!r.hoist });

  function guildRoles(g) {
    let roles = null;
    const rs = mod.GuildRoleStore;
    for (const f of ['getSortedRoles', 'getRoles', 'getRolesSnapshot']) {
      if (roles) break;
      try {
        if (rs && typeof rs[f] === 'function') roles = rs[f](g.id);
      } catch (e) {}
    }
    try {
      if (!roles && typeof mod.GuildStore.getRoles === 'function') roles = mod.GuildStore.getRoles(g.id);
    } catch (e) {}
    if (!roles) roles = g.roles;
    const list = Array.isArray(roles) ? roles : Object.values(roles || {});
    return list.filter((r) => r && r.id && typeof r.name === 'string').map(pickRole);
  }

  /** The members the client has loaded (it loads them lazily), this account first so the cap never drops it. */
  function guildMembers(guildId, selfId) {
    const gm = mod.GuildMemberStore;
    if (!gm) return [];
    let list = [];
    try {
      if (typeof gm.getMembers === 'function') list = gm.getMembers(guildId) || [];
      else if (typeof gm.getMemberIds === 'function') list = (gm.getMemberIds(guildId) || []).map((id) => gm.getMember(guildId, id));
    } catch (e) {
      list = [];
    }
    list = Array.isArray(list) ? list : Object.values(list);
    const memberId = (m) => m && (m.userId ?? (m.user && m.user.id));
    const mine = list.find((m) => memberId(m) === selfId);
    const ordered = mine ? [mine, ...list.filter((m) => m !== mine)] : list;
    const out = [];
    for (const m of ordered) {
      if (out.length >= MEMBER_CAP) break;
      const user = resolveUser(memberId(m));
      if (!user || !user.username) continue;
      out.push({ user, roles: Array.isArray(m.roles) ? m.roles.filter((r) => typeof r === 'string') : [], color: m.colorString || null });
    }
    return out;
  }

  function memberCount(g) {
    try {
      const n = mod.GuildMemberCountStore && mod.GuildMemberCountStore.getMemberCount(g.id);
      if (typeof n === 'number') return n;
    } catch (e) {}
    return typeof g.memberCount === 'number' ? g.memberCount : null;
  }

  function aboutGuildParts(out, g, selfId) {
    out.guild = pickAboutGuild(g);
    out.roles = guildRoles(g);
    out.members = guildMembers(g.id, selfId);
    out.memberCount = memberCount(g);
  }

  function about(cmd) {
    const me = currentUser();
    const selfId = (me && me.id) || null;
    const out = { selfId, can: {} };
    if (cmd.target === 'space') {
      const g = mod.GuildStore.getGuild(cmd.id);
      if (g) {
        aboutGuildParts(out, g, selfId);
        out.can = canAll(g);
        return out;
      }
    }
    const c = mod.ChannelStore.getChannel(cmd.id);
    if (!c || (cmd.target === 'space') !== (c.type === CATEGORY)) throw new Error(cmd.target === 'space' ? 'unknown server or category' : 'unknown channel');
    out.channel = pickAboutChannel(c);
    out.can = canAll(c);
    const g = out.channel.guild_id ? mod.GuildStore.getGuild(out.channel.guild_id) : null;
    if (g) {
      aboutGuildParts(out, g, selfId);
      out.guildCan = canAll(g);
    }
    return out;
  }

  // One PATCH through the client's REST module, with only the fields a setting can change.
  const PATCHABLE = { channel: ['name', 'topic', 'rate_limit_per_user', 'nsfw'], guild: ['name'] };
  async function configure(cmd) {
    const which = cmd.guildId ? 'guild' : 'channel';
    const id = cmd.guildId || cmd.channelId;
    if (!/^\d+$/.test(String(id || ''))) throw new Error('which ' + which + '?');
    const body = {};
    for (const k of PATCHABLE[which]) if (cmd.patch && cmd.patch[k] !== undefined) body[k] = cmd.patch[k];
    if (!Object.keys(body).length) throw new Error('nothing to change');
    const res = await rest('patch', which === 'guild' ? `/guilds/${id}` : `/channels/${id}`, undefined, body);
    const raw = res && res.body;
    return which === 'guild' ? { guild: (raw && pickGuild(raw)) || null } : { channel: (raw && pickChannel(raw)) || null };
  }

  // ------------------------------------------------------------------ profiles
  // What the client shows when you open someone's profile. Its own fetch, run as a click on them runs it (which
  // skips one it made in the last minute), then its stores; without those, the same request through its REST client.
  // Every part is optional: a store that is missing or throws leaves its part out.
  const fnSource = (f) => {
    try {
      return Function.prototype.toString.call(f);
    } catch (e) {
      return '';
    }
  };
  const isProfileFetch = (f) => {
    const s = fnSource(f);
    return s.includes('"USER_PROFILE_FETCH_START"') && s.includes('with_mutual_guilds');
  };
  const isProfileOpen = (f) => {
    const s = fnSource(f);
    return s.includes('waitForRefetch') && s.includes('isFetchingProfile');
  };
  /** The one function a module exports that passes `test`; export names are mangled, so it is found by its code. */
  function exportedFn(m, max, test) {
    try {
      const v = Object.values(m);
      return (v.length <= max && v.find((f) => typeof f === 'function' && test(f))) || null;
    } catch (e) {
      return null;
    }
  }
  const CUSTOM_STATUS = 4;
  const FRIEND = 1;
  let profileRescanAt = 0;

  async function profile(cmd) {
    const who = String(cmd.userId || '');
    if (!/^\d+$/.test(who)) throw new Error('whose profile?');
    // The profile modules can come with a later chunk than the finders waited for.
    if ((!mod.UserProfileStore || !(mod.ProfileOpen || mod.ProfileFetch)) && Date.now() - profileRescanAt > 60_000) {
      profileRescanAt = Date.now();
      resolveModules();
    }
    const me = currentUser();
    const selfId = (me && me.id) || null;
    const self = who === selfId;
    let body = null;
    let error;
    try {
      body = await fetchProfile(who, self);
    } catch (e) {
      // Rate limited: say so, rather than answer with a profile missing most of its parts.
      if (e && (e.status === 429 || (e.body && e.body.retry_after))) throw e;
      error = describeError(e);
    }
    const out = { selfId, ...profileParts(who, body), ...relationshipOf(who), custom_status: customStatus(who) };
    if (self) out.friends = friendList();
    if (error) out.error = error;
    return out;
  }

  async function fetchProfile(who, self) {
    const opts = { type: 'popout', withMutualGuilds: !self, withMutualFriends: !self };
    const open = mod.UserProfileStore && mod.ProfileOpen && exportedFn(mod.ProfileOpen, 2, isProfileOpen);
    if (open) {
      await open(who, undefined, opts);
      return null;
    }
    const run = mod.ProfileFetch && exportedFn(mod.ProfileFetch, 12, isProfileFetch);
    let body = null;
    if (run) {
      await run(who, opts, (b) => {
        body = b;
      });
      return body;
    }
    const res = await rest('get', `/users/${who}/profile`, { type: 'popout', with_mutual_guilds: !self, with_mutual_friends: !self });
    return (res && res.body) || null;
  }

  const isoOf = (t) => (typeof t === 'string' ? t : t && typeof t.toISOString === 'function' ? t.toISOString() : null);
  const numOf = (n) => (typeof n === 'number' ? n : null);
  const textOf = (s) => (typeof s === 'string' ? s : null);

  /** The profile proper: the store's copy (camelCase) or the REST body (snake_case), and the user record. */
  function profileParts(who, body) {
    const ps = mod.UserProfileStore;
    const ask = (f, ...a) => {
      try {
        return ps && typeof ps[f] === 'function' ? ps[f](...a) : undefined;
      } catch (e) {
        return undefined;
      }
    };
    const p = ask('getUserProfile', who) || {};
    const b = body || {};
    const bp = b.user_profile || {};
    const bu = b.user || {};
    let rec = null;
    try {
      rec = mod.UserStore.getUser(who) || null;
    } catch (e) {}
    const accounts = Array.isArray(p.connectedAccounts) ? p.connectedAccounts : Array.isArray(b.connected_accounts) ? b.connected_accounts : [];
    let guilds = ask('getMutualGuilds', who);
    if (!Array.isArray(guilds) && Array.isArray(b.mutual_guilds)) guilds = b.mutual_guilds.map((g) => g && { guild: guildOf(g.id) || { id: g.id }, nick: g.nick });
    const friends = ask('getMutualFriends', who);
    const out = {
      user: pickUser(rec) || pickUser(b.user) || null,
      bio: textOf(p.bio ?? bp.bio ?? bu.bio),
      pronouns: textOf(p.pronouns ?? bp.pronouns),
      banner: textOf(p.banner ?? bp.banner ?? bu.banner ?? (rec && rec.banner)),
      accent_color: numOf(p.accentColor ?? bp.accent_color ?? bu.accent_color),
      legacy_username: textOf(p.legacyUsername ?? b.legacy_username),
      connected_accounts: accounts.map(pickConnection).filter(Boolean),
      mutual_guilds: Array.isArray(guilds) ? guilds.map((x) => x && mutualGuild(x.guild, x.nick, who)).filter(Boolean) : null,
      mutual_friends: Array.isArray(friends) ? friends.map((f) => pickUser(f && f.user)).filter(Boolean) : Array.isArray(b.mutual_friends) ? b.mutual_friends.map(pickUser).filter(Boolean) : null,
      mutual_friends_count: numOf(ask('getMutualFriendsCount', who) ?? b.mutual_friends_count),
    };
    // The store keeps why its last fetch failed, also when the client skipped this one for it.
    if (p.fetchError) out.error = describeError(p.fetchError);
    return out;
  }

  function guildOf(id) {
    try {
      return mod.GuildStore.getGuild(id) || null;
    } catch (e) {
      return null;
    }
  }

  /** A shared server: its name, their nickname, and their roles and join date when the client has them as a member. */
  function mutualGuild(g, nick, who) {
    if (!g || !g.id) return null;
    let member = null;
    try {
      member = (mod.GuildMemberStore && mod.GuildMemberStore.getMember(g.id, who)) || null;
    } catch (e) {}
    const out = { id: g.id, name: textOf(g.name) ?? undefined, nick: nick ?? (member && member.nick) ?? null, joined_at: member ? isoOf(member.joinedAt ?? member.joined_at) : null };
    if (member && Array.isArray(member.roles)) {
      const byId = new Map(guildRoles(g).map((r) => [r.id, r]));
      out.roles = member.roles.map((id) => byId.get(id)).filter(Boolean);
    }
    return out;
  }

  /** A connected account, with the name and link the client's own table gives its platform. Ones it does not show are left out. */
  function pickConnection(a) {
    if (!a || typeof a.type !== 'string' || typeof a.name !== 'string') return null;
    const table = mod.Platforms;
    let platform = null;
    try {
      if (table && !table.isSupported(a.type)) return null;
      platform = table ? table.get(a.type) : null;
    } catch (e) {}
    let url = null;
    try {
      if (platform && typeof platform.getPlatformUserUrl === 'function') url = platform.getPlatformUserUrl({ type: a.type, id: a.id, name: a.name });
    } catch (e) {}
    return {
      type: a.type,
      id: a.id != null ? String(a.id) : undefined,
      name: a.name,
      verified: !!a.verified,
      label: platform && typeof platform.name === 'string' ? platform.name : undefined,
      url: typeof url === 'string' && url.startsWith('https://') ? url : undefined,
    };
  }

  function relationshipOf(who) {
    const rs = mod.RelationshipStore;
    if (!rs) return { relationship: null, friend_since: null };
    let type = null;
    try {
      if (typeof rs.getRelationshipType === 'function') type = rs.getRelationshipType(who);
      else type = relationshipTypes().get(who) ?? 0;
    } catch (e) {}
    let since = null;
    try {
      if (typeof rs.getSince === 'function') since = isoOf(rs.getSince(who));
    } catch (e) {}
    return { relationship: numOf(type), friend_since: since };
  }

  /** Every relationship's type by user id, whichever shape this build keeps them in. */
  function relationshipTypes() {
    const rs = mod.RelationshipStore;
    const all = typeof rs.getMutableRelationships === 'function' ? rs.getMutableRelationships() : typeof rs.getRelationships === 'function' ? rs.getRelationships() : null;
    const entries = all instanceof Map ? Array.from(all.entries()) : Object.entries(all || {});
    return new Map(entries.map(([id, r]) => [id, typeof r === 'number' ? r : r && r.type]));
  }

  function friendList() {
    const rs = mod.RelationshipStore;
    let ids = [];
    try {
      if (typeof rs.getFriendIDs === 'function') ids = rs.getFriendIDs() || [];
      else ids = Array.from(relationshipTypes()).filter(([, t]) => t === FRIEND).map(([id]) => id);
    } catch (e) {}
    return Array.from(ids).map((id) => resolveUser(id) || { id });
  }

  function customStatus(who) {
    let acts = null;
    try {
      acts = mod.PresenceStore && mod.PresenceStore.getActivities(who);
    } catch (e) {}
    const a = Array.isArray(acts) ? acts.find((x) => x && x.type === CUSTOM_STATUS) : null;
    if (!a || (!a.state && !a.emoji)) return null;
    return { text: textOf(a.state), emoji: a.emoji ? pickEmoji(a.emoji) : null };
  }

  // How the client itself sends files: ask for upload URLs, PUT the bytes straight to storage, then post
  // a message that names them. Nothing but the message goes through Discord's API proper.
  async function sendWithFiles(cmd) {
    const declared = cmd.files.map((f, i) => ({ id: String(i), filename: f.name, file_size: f.size }));
    const slots = await rest('post', `/channels/${cmd.channelId}/attachments`, undefined, { files: declared });
    const attachments = await Promise.all(
      slots.body.attachments.map(async (slot) => {
        const f = cmd.files[Number(slot.id)];
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        const put = await fetch(slot.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': f.mime } });
        if (!put.ok) throw new Error(`uploading ${f.name} failed: HTTP ${put.status}`);
        return { id: slot.id, filename: f.name, uploaded_filename: slot.upload_filename };
      }),
    );
    const body = { content: cmd.content, nonce: cmd.nonce, tts: false, channel_id: cmd.channelId, type: 0, sticker_ids: [], attachments };
    if (cmd.replyTo) body.message_reference = { channel_id: cmd.channelId, message_id: cmd.replyTo };
    const res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, body);
    return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
  }

  async function sendMessage(cmd) {
    if (cmd.files && cmd.files.length) return sendWithFiles(cmd);
    const ma = mod.MessageActions;
    if (ma && ma.sendMessage) {
      const options = { nonce: cmd.nonce, ...(cmd.replyTo ? { messageReference: { channel_id: cmd.channelId, message_id: cmd.replyTo } } : {}) };
      // false: by default this waits for the channel to load, which only happens once it is on screen.
      const res = await ma.sendMessage(cmd.channelId, { content: cmd.content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, options);
      return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
    }
    const body = { content: cmd.content, nonce: cmd.nonce, tts: false };
    if (cmd.replyTo) body.message_reference = { channel_id: cmd.channelId, message_id: cmd.replyTo };
    const res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, body);
    return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
  }

  // Forwarding, as the client's Forward dialog does it: a message with no content whose message_reference has
  // type FORWARD, which the client's own send turns into a forward (MessageActions._sendMessage checks for it),
  // then the note as an ordinary message. The dialog itself is a lazily loaded chunk; its send ends in the same call.
  const REFERENCE_FORWARD = 1;
  async function forwardMessage(cmd) {
    const source = mod.ChannelStore.getChannel(cmd.source.channelId);
    const reference = { guild_id: (source && (source.guild_id ?? source.guildId)) || undefined, channel_id: cmd.source.channelId, message_id: cmd.source.messageId, type: REFERENCE_FORWARD };
    const ma = mod.MessageActions;
    let res;
    if (ma && ma.sendMessage) res = await ma.sendMessage(cmd.channelId, { content: '', tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, { nonce: cmd.nonce, messageReference: reference });
    else res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, { content: '', nonce: cmd.nonce, tts: false, message_reference: reference });
    const id = res && res.body ? res.body.id : null;
    if (cmd.note && cmd.note.trim()) await sendMessage({ channelId: cmd.channelId, content: cmd.note, nonce: nextNonce(cmd.nonce) });
    return { nativeId: id };
  }
  // A snowflake-shaped nonce just after another, for the note that follows a forward.
  const nextNonce = (n) => {
    try {
      return String(BigInt(n) + 1n);
    } catch (e) {
      return String(Date.now());
    }
  };

  // Never openPrivateChannel itself: that also navigates the sandbox's page to the DM.
  async function openDirect(userId) {
    const describe = (channelId, existed, raw) => ({ channelId, existed, channel: pickChannel(raw || mod.ChannelStore.getChannel(channelId)) || null });
    const known = mod.ChannelStore.getDMFromUserId && mod.ChannelStore.getDMFromUserId(userId);
    if (known) return describe(known, true);
    const actions = mod.PrivateChannelActions;
    const ensure = actions && (actions.getOrEnsurePrivateChannel || actions.ensurePrivateChannel);
    if (ensure) {
      const r = await ensure.call(actions, userId);
      const id = typeof r === 'string' ? r : r && ((r.body && r.body.id) || r.id);
      if (!id) throw new Error('the Discord client did not say which channel it opened');
      return describe(id, false, r && r.body);
    }
    const res = await rest('post', '/users/@me/channels', undefined, { recipients: [userId] });
    return describe(res.body.id, false, res.body);
  }

  async function history(cmd) {
    const query = { limit: Math.min(cmd.limit || 50, 100) };
    if (cmd.beforeId) query.before = cmd.beforeId;
    const res = await rest('get', `/channels/${cmd.channelId}/messages`, query);
    const arr = (res && res.body) || [];
    return { messages: arr.map(pickMessage).filter(Boolean) };
  }

  async function rest(verb, url, query, body) {
    const r = mod.Rest;
    if (!r || typeof r[verb] !== 'function') throw new Error('REST module unavailable (' + verb + ')');
    const res = await r[verb]({ url, query, body });
    return res;
  }

  // ------------------------------------------------------------- signing in
  // When a login fails, the page just starts over. Discord's own log says why, so pass that on, while
  // signing in only: the route, the status, the captcha verdict and the message. Never tickets or tokens.
  const isLogReader = (f) => typeof f === 'function' && f.length <= 1 && /\.toArray\(\)\.filter\(/.test(Function.prototype.toString.call(f));
  const LOGIN_ROUTE = /\/(auth\/[\w/-]+|users\/@me\/remote-auth[\w/-]*)/;
  let trailUpTo = '';

  function readLoginTrail() {
    if (!mod.ClientLog || snapshotSent) return;
    let lines;
    try {
      lines = Object.values(mod.ClientLog).find(isLogReader)(['Network']).split('\n');
    } catch (e) {
      return;
    }
    for (const line of lines) {
      const hit = line.match(/^(\S+) -> .*Completed \w+ to (\S+) with status: (\d+) and body: (.*)$/);
      if (!hit || hit[1] <= trailUpTo) continue;
      const route = hit[2].match(LOGIN_ROUTE);
      if (!route) continue;
      trailUpTo = hit[1];
      let body = {};
      try {
        body = JSON.parse(hit[4]);
      } catch (e) {
        /* not JSON: the status is still worth having */
      }
      up({
        t: 'loginIssue',
        route: route[1],
        status: Number(hit[3]),
        captcha: Array.isArray(body.captcha_key) ? String(body.captcha_key[0]) : undefined,
        message: typeof body.message === 'string' ? body.message.slice(0, 160) : undefined,
        code: typeof body.code === 'number' ? body.code : undefined,
      });
    }
  }

  /** The WebGL renderer the page sees, for the log: a sandbox without one looks nothing like a desktop browser. */
  function webglRenderer() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return gl ? (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'on') : 'off';
    } catch (e) {
      return 'off';
    }
  }

  // --------------------------------------------------------------- page state
  function detectPageState() {
    const href = location.href;
    const path = location.pathname;
    let state = 'loading';
    if (/\/login|\/register/.test(path)) state = 'login';
    else if (/^\/(app|channels)/.test(path)) state = 'app';
    // captcha / verification overlays
    if (document.querySelector('iframe[src*="hcaptcha"], iframe[src*="captcha"]')) state = 'captcha';
    const bodyText = (document.body && document.body.innerText) || '';
    if (/suspicious activity|verify your|phone number to continue|verification required/i.test(bodyText)) state = 'verify';
    // Discord's full-page error when a lazy chunk will not load.
    if (/Loading chunk \S+ failed/i.test(bodyText)) {
      state = 'crashed';
      reloadAfterCrash();
    }
    up({ t: 'page', state, url: href });
    return state;
  }

  // A reload is what a person would do here, and it nearly always works. At most
  // three per ten minutes, so a page that keeps failing stays up for the live view.
  let reloadScheduled = false;
  function reloadAfterCrash() {
    if (reloadScheduled) return;
    const key = TAG + 'reloads';
    let recent = [];
    try {
      recent = JSON.parse(sessionStorage.getItem(key) || '[]').filter((t) => Date.now() - t < 10 * 60_000);
    } catch (e) {}
    if (recent.length >= 3) return;
    reloadScheduled = true;
    recent.push(Date.now());
    try {
      sessionStorage.setItem(key, JSON.stringify(recent));
    } catch (e) {}
    log('warn', 'Discord could not load a chunk; reloading the page');
    setTimeout(() => location.reload(), 5000);
  }

  // The REST client rejects with its response object, not an Error.
  function describeError(err) {
    if (err && err.status) return `${(err.body && err.body.message) || 'HTTP error'} (${err.status})`;
    return String((err && err.message) || err);
  }

  // ------------------------------------------------------------------- wiring
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'down') return;
    const payload = e.data.payload;
    if (!payload) return;
    if (payload.t === 'cmd') {
      Promise.resolve()
        .then(() => runCommand(payload.cmd))
        .then((result) => up({ t: 'reply', id: payload.id, ok: true, result }))
        .catch((err) => up({ t: 'reply', id: payload.id, ok: false, error: describeError(err), retryAfter: err && err.body && err.body.retry_after }));
    }
  });

  /*@dither-lab@*/
  installWebpackHook();
  setTimeout(resolveTick, 500);

  // Page-state polling so the adapter can show login / captcha / verify promptly.
  const poll = () => {
    detectPageState();
    readLoginTrail();
    // CONNECTION_OPEN may have fired before we subscribed; it re-sends the full picture when it does fire.
    if (coreReady && !snapshotSent && currentUser()) maybeSendSnapshot('logged in');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  poll();
  setInterval(poll, 3000);
  // Surfaced in the adapter log so the "not automated" property is easy to confirm.
  log('info', 'hook.js installed; navigator.webdriver=' + String(navigator.webdriver) + '; devicePixelRatio=' + window.devicePixelRatio + '; webgl=' + webglRenderer());
})();
