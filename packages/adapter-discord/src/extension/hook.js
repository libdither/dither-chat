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
    ThreadStore: isStore('ThreadsStore', 'ThreadStore', 'ActiveThreadsStore'),
    // REST client: an object exposing the http verbs.
    Rest: (m) => ['get', 'post', 'put', 'patch', 'del'].every((k) => typeof m[k] === 'function'),
    // Message actions: sendMessage / editMessage / fetchMessages.
    MessageActions: (m) => typeof m.sendMessage === 'function' && typeof m.editMessage === 'function',
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
  const pickEmoji = (e) => e && { id: e.id ?? null, name: e.name ?? null };
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
      reactions: Array.isArray(m.reactions) ? m.reactions.map((r) => ({ emoji: pickEmoji(r.emoji), count: r.count, me: !!r.me })) : undefined,
      message_reference: m.message_reference ?? (m.messageReference ? { message_id: m.messageReference.messageId ?? m.messageReference.message_id, channel_id: m.messageReference.channelId } : undefined),
      thread: m.thread ? pickChannel(m.thread) : undefined,
      message_snapshots: Array.isArray(m.message_snapshots)
        ? m.message_snapshots.map((s) => s.message && { content: s.message.content ?? '', attachments: (s.message.attachments ?? []).map(pickAttachment), embeds: (s.message.embeds ?? []).map(pickEmbed) }).filter(Boolean)
        : undefined,
      sticker_items: Array.isArray(m.sticker_items) ? m.sticker_items.map((s) => ({ name: s.name })) : undefined,
      poll: m.poll && m.poll.question ? { question: m.poll.question.text, answers: (m.poll.answers ?? []).map((a) => a.poll_media && a.poll_media.text).filter(Boolean) } : undefined,
    };
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
      const rel = mod.RelationshipStore;
      if (rel) {
        const map = rel.getRelationships ? rel.getRelationships() : {};
        data.relationships = Object.entries(map).map(([id, type]) => ({ id, type }));
        for (const id of Object.keys(map)) addUser(resolveUser(id));
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
        return { channelId: a.channelId, messageId: a.messageId, userId: a.userId, emoji: pickEmoji(a.emoji) };
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
        return { channelId: a.channelId, userId: a.userId };
      default:
        return {};
    }
  }

  // --------------------------------------------------------------- commands
  async function runCommand(cmd) {
    if (!coreReady) throw new Error('the Discord client has not finished loading');
    switch (cmd.kind) {
      case 'send':
        return sendMessage(cmd);
      case 'history':
        return history(cmd);
      case 'markRead':
        return rest('post', `/channels/${cmd.channelId}/messages/${cmd.messageId}/ack`, undefined, { token: null });
      case 'react': {
        const e = encodeURIComponent(cmd.emoji);
        if (cmd.remove) return rest('del', `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions/${e}/@me`);
        return rest('put', `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions/${e}/@me`);
      }
      case 'edit':
        if (mod.MessageActions && mod.MessageActions.editMessage) return mod.MessageActions.editMessage(cmd.channelId, cmd.messageId, { content: cmd.content }), { ok: true };
        return rest('patch', `/channels/${cmd.channelId}/messages/${cmd.messageId}`, undefined, { content: cmd.content });
      case 'redact':
        if (mod.MessageActions && mod.MessageActions.deleteMessage) return mod.MessageActions.deleteMessage(cmd.channelId, cmd.messageId), { ok: true };
        return rest('del', `/channels/${cmd.channelId}/messages/${cmd.messageId}`);
      default:
        throw new Error('unknown command ' + cmd.kind);
    }
  }

  async function sendMessage(cmd) {
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

  installWebpackHook();
  setTimeout(resolveTick, 500);

  // Page-state polling so the adapter can show login / captcha / verify promptly.
  const poll = () => {
    detectPageState();
    // CONNECTION_OPEN may have fired before we subscribed; it re-sends the full picture when it does fire.
    if (coreReady && !snapshotSent && currentUser()) maybeSendSnapshot('logged in');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  poll();
  setInterval(poll, 3000);
  // Surfaced in the adapter log so the "not automated" property is easy to confirm.
  log('info', 'hook.js installed; navigator.webdriver=' + String(navigator.webdriver));
})();
