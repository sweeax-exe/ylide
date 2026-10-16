// Makes the Ylide Discord server match src/spec.js and src/content.js.
//
//   npm run setup -- --dry-run      show what would change, change nothing
//   npm run setup                   apply
//
// Options:
//   --remove-default-channels  delete Discord's starter categories ("Text Channels",
//                              "Voice Channels", or their German names) once they
//                              are empty, and the starter voice channel
//   --refresh-emojis           upload the bot's emojis again (after new art)
//
// Running it twice changes nothing: everything is matched by name and only
// updated when it differs. It never deletes roles or channels it does not
// own; in its own info channels it keeps exactly its own messages.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REST } from 'discord.js';
import { loadEnv } from '../env.js';
import * as spec from '../spec.js';
import { messages as content } from '../content.js';
import { emojiNames } from '../theme.js';
import { everyoneBase, names as permNames } from '../permissions.js';
import { commands } from '../bot/commands.js';
import { IS_COMPONENTS_V2 } from '../components.js';
import { matches, mergeOverwrites, sameOverwrites, sidebarOrder, inOrder } from './compare.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const asset = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const env = loadEnv();
const G = env.guildId;
const rest = new REST({ version: '10' }).setToken(env.token);

// --- report -----------------------------------------------------------------

const changes = [];
let unchanged = 0;
const change = (line) => {
  changes.push(line);
  console.log(`${dryRun ? 'would ' : ''}${line}`);
};
const same = () => unchanged++;

// In a dry run, things that would be created get placeholder ids.
let placeholderCount = 0;
const placeholder = (what) => `new:${what}:${++placeholderCount}`;
const isPlaceholder = (id) => typeof id === 'string' && id.startsWith('new:');

async function call(method, route, options) {
  if (dryRun && method !== 'get') return null;
  return rest[method](route, options);
}

// --- helpers ----------------------------------------------------------------

function fakeSnowflake(offset) {
  return ((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(offset)).toString();
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);
}

function permissionsOf(guild, member) {
  const everyone = guild.roles.find((r) => r.id === guild.id);
  let perms = BigInt(everyone.permissions);
  for (const role of guild.roles) if (member.roles.includes(role.id)) perms |= BigInt(role.permissions);
  return perms;
}

const ADMIN = 1n << 3n;

// --- steps ------------------------------------------------------------------

// The bot's avatar and the application icon: the Ylide mark, set once when
// they are still Discord's default (later changes in the portal are kept).
async function syncProfile(me) {
  const image = `data:image/png;base64,${readFileSync(asset(spec.guild.icon)).toString('base64')}`;
  if (me.avatar) same();
  else {
    change('set the bot avatar');
    await call('patch', '/users/@me', { body: { avatar: image } });
  }
  const app = await rest.get('/applications/@me');
  if (app.icon) same();
  else {
    change('set the application icon');
    await call('patch', '/applications/@me', { body: { icon: image } });
  }
}

async function syncEmojis() {
  const { items } = await rest.get(`/applications/${env.appId}/emojis`);
  const byName = Object.fromEntries(items.map((e) => [e.name, e.id]));
  for (const name of emojiNames) {
    const path = asset(`assets/emoji/${name}.png`);
    let image;
    try {
      image = `data:image/png;base64,${readFileSync(path).toString('base64')}`;
    } catch {
      console.warn(`  missing ${path}; run "npm run art" first`);
      continue;
    }
    if (byName[name] && args.has('--refresh-emojis')) {
      change(`replace emoji :${name}:`);
      await call('delete', `/applications/${env.appId}/emojis/${byName[name]}`);
      delete byName[name];
    }
    if (byName[name]) {
      same();
      continue;
    }
    change(`upload emoji :${name}:`);
    const created = await call('post', `/applications/${env.appId}/emojis`, { body: { name, image } });
    byName[name] = created?.id ?? placeholder('emoji');
  }
  return byName;
}

async function syncRoles(guild, botMember) {
  const ids = {};
  const botTop = Math.max(...guild.roles.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position));
  for (const role of spec.roles) {
    const desired = { name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.toString() };
    const live = guild.roles.find((r) => r.name === role.name && !r.managed);
    if (!live) {
      change(`create role ${role.name}`);
      const created = await call('post', `/guilds/${G}/roles`, { body: desired, reason: 'Ylide setup' });
      ids[role.key] = created?.id ?? placeholder(`role-${role.key}`);
      continue;
    }
    ids[role.key] = live.id;
    if (live.position >= botTop) {
      throw new Error(`The role "${role.name}" is above the bot's role. Drag the bot's role (Ylide) to the top in Server Settings > Roles.`);
    }
    const diff = Object.keys(desired).filter((key) => !matches(key === 'permissions' ? BigInt(desired[key]) : desired[key], live[key]));
    if (diff.length) {
      change(`update role ${role.name}: ${diff.join(', ')}`);
      await call('patch', `/guilds/${G}/roles/${live.id}`, { body: desired, reason: 'Ylide setup' });
    } else same();
  }

  // @everyone: the base permissions every member has.
  const everyone = guild.roles.find((r) => r.id === guild.id);
  if (BigInt(everyone.permissions) !== everyoneBase) {
    change(`set @everyone permissions to ${permNames(everyoneBase).length} base permissions`);
    await call('patch', `/guilds/${G}/roles/${guild.id}`, { body: { permissions: everyoneBase.toString() }, reason: 'Ylide setup' });
  } else same();

  // Order: our roles as one block directly below the bot's role, in spec order.
  // New roles start at the bottom and push the others (the bot's too) up one.
  // Right after creating roles Discord sometimes applies a new order only in
  // part, so the order is checked again (up to three times).
  let reordered = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = dryRun ? guild.roles : await rest.get(`/guilds/${G}/roles`);
    const top = Math.max(...fresh.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position));
    const below = fresh.filter((r) => r.position < top && r.id !== guild.id).sort((a, b) => b.position - a.position);
    const ours = spec.roles.map((r) => ids[r.key]);
    const others = below.filter((r) => !ours.includes(r.id));
    const wanted = [...ours, ...others.map((r) => r.id)];
    const current = below.map((r) => r.id);
    if (!ours.some(isPlaceholder) && JSON.stringify(wanted) === JSON.stringify(current)) break;
    if (!reordered) change('reorder roles');
    reordered = true;
    const positions = wanted.map((id, i) => ({ id, position: top - 1 - i })).filter((p) => p.position > 0);
    await call('patch', `/guilds/${G}/roles`, { body: positions, reason: 'Ylide setup' });
    if (dryRun) break;
  }
  if (!reordered) same();
  return ids;
}

// The server owner gets the Founder role (looked up from the server, so no
// personal ID is kept in this repository).
async function syncOwnerRole(guild, roleIds) {
  const owner = await rest.get(`/guilds/${G}/members/${guild.owner_id}`);
  if (owner.roles.includes(roleIds.founder)) return same();
  change('give the server owner the Founder role');
  if (!isPlaceholder(roleIds.founder)) await call('put', `/guilds/${G}/members/${guild.owner_id}/roles/${roleIds.founder}`, { reason: 'Ylide setup' });
}

function resolveOverwrites(list, ctx) {
  return list.map((o) => {
    if (o.target === 'everyone') return { id: G, type: 0, allow: o.allow, deny: o.deny };
    if (o.target === 'bot') return { id: ctx.botId, type: 1, allow: o.allow, deny: o.deny };
    const id = ctx.roles[o.target];
    if (!id) throw new Error(`unknown overwrite target ${o.target}`);
    return { id, type: 0, allow: o.allow, deny: o.deny };
  });
}

const apiOverwrites = (list) => list.map((o) => ({ id: o.id, type: o.type, allow: o.allow.toString(), deny: o.deny.toString() }));

const textLike = new Set([0, 5, 15]);
const compatible = (want, have) => want === have || (want === 5 && have === 0) || (want === 0 && have === 5);

function desiredChannel(channel, parentId, overwrites, live) {
  const type = spec.ChannelType[channel.type];
  const body = { name: channel.name, type, parent_id: parentId, permission_overwrites: apiOverwrites(overwrites) };
  if (textLike.has(type)) {
    body.topic = channel.topic ?? null;
    body.rate_limit_per_user = channel.rateLimit ?? 0;
  }
  if (type === 15) {
    const liveTags = live?.available_tags ?? [];
    const tags = channel.tags.map((t) => {
      const existing = liveTags.find((l) => l.name === t.name);
      return { ...(existing ? { id: existing.id } : {}), name: t.name, moderated: Boolean(t.moderated), emoji_id: null, emoji_name: null };
    });
    // Tags the team added by hand stay.
    for (const l of liveTags) if (!channel.tags.some((t) => t.name === l.name)) tags.push(l);
    body.available_tags = tags;
    body.default_reaction_emoji = channel.reaction ? { emoji_id: null, emoji_name: channel.reaction } : null;
    body.default_forum_layout = channel.layout === 'gallery' ? 2 : 1;
    body.default_sort_order = 0;
    body.flags = channel.flags ?? 0;
  }
  return body;
}

function channelDiff(body, live) {
  const diff = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'permission_overwrites') {
      if (!sameOverwrites(value, live.permission_overwrites)) diff.push('permissions');
    } else if (key === 'available_tags') {
      const want = value.map((t) => [t.name, t.moderated]);
      const have = (live.available_tags ?? []).map((t) => [t.name, Boolean(t.moderated)]);
      if (JSON.stringify(want) !== JSON.stringify(have)) diff.push('tags');
    } else if (key === 'topic') {
      if ((value ?? '') !== (live.topic ?? '')) diff.push('topic');
    } else if (key === 'flags') {
      if ((Number(live.flags ?? 0) & value) !== value) diff.push('flags');
    } else if (key === 'default_reaction_emoji') {
      if ((value?.emoji_name ?? null) !== (live.default_reaction_emoji?.emoji_name ?? null)) diff.push('reaction');
    } else if (!matches(value, live[key] ?? (key === 'parent_id' ? null : live[key]))) diff.push(key.replace(/_/g, ' '));
  }
  return diff;
}

async function syncChannels(ctx, live, { types }) {
  for (const category of spec.categories) {
    const catOverwrites = resolveOverwrites(category.overwrites ?? [], ctx);
    if (types.has(4)) {
      const existing = live.find((c) => c.type === 4 && c.name.toLowerCase() === category.name.toLowerCase());
      const body = { name: category.name, type: 4, permission_overwrites: apiOverwrites(catOverwrites) };
      if (!existing) {
        change(`create category ${category.name}`);
        const created = await call('post', `/guilds/${G}/channels`, { body, reason: 'Ylide setup' });
        ctx.cat[category.key] = created?.id ?? placeholder(`category-${category.key}`);
        if (created) live.push(created);
      } else {
        ctx.cat[category.key] = existing.id;
        const diff = channelDiff(body, existing);
        if (diff.length) {
          change(`update category ${category.name}: ${diff.join(', ')}`);
          const updated = await call('patch', `/channels/${existing.id}`, { body, reason: 'Ylide setup' });
          if (updated) Object.assign(existing, updated);
        } else same();
      }
    }
    for (const channel of category.channels) {
      const type = spec.ChannelType[channel.type];
      if (!types.has(type)) continue;
      const overwrites = mergeOverwrites(category.overwrites ?? [], channel.overwrites ?? []);
      const resolved = resolveOverwrites(overwrites, ctx);
      const names = [channel.name, ...(channel.aliases ?? [])].map((n) => n.toLowerCase());
      const existing =
        live.find((c) => c.name === channel.name && compatible(type, c.type)) ?? live.find((c) => names.includes(c.name.toLowerCase()) && compatible(type, c.type));
      const body = desiredChannel(channel, ctx.cat[category.key], resolved, existing);
      if (!existing) {
        change(`create ${channel.type} channel #${channel.name} in ${category.name}`);
        const created = isPlaceholder(body.parent_id) ? null : await call('post', `/guilds/${G}/channels`, { body, reason: 'Ylide setup' });
        ctx.ch[channel.key] = created?.id ?? placeholder(`channel-${channel.key}`);
        if (created && body.flags) {
          // Discord ignores flags (such as "posts need a tag") when it creates a channel.
          Object.assign(created, await call('patch', `/channels/${created.id}`, { body: { flags: body.flags }, reason: 'Ylide setup' }));
        }
        if (created) live.push(created);
        continue;
      }
      ctx.ch[channel.key] = existing.id;
      const diff = channelDiff(body, existing);
      if (diff.length) {
        change(`update #${channel.name}: ${diff.join(', ')}`);
        const updated = await call('patch', `/channels/${existing.id}`, { body, reason: 'Ylide setup' });
        if (updated) Object.assign(existing, updated);
      } else same();
    }
  }
}

async function syncGuild(guild, ctx) {
  const s = spec.guild;
  const body = {
    description: s.description,
    verification_level: s.verificationLevel,
    explicit_content_filter: s.explicitContentFilter,
    default_message_notifications: s.defaultNotifications,
    preferred_locale: s.preferredLocale,
    rules_channel_id: ctx.ch[s.rulesChannel],
    public_updates_channel_id: ctx.ch[s.updatesChannel],
    safety_alerts_channel_id: ctx.ch[s.safetyAlertsChannel],
    system_channel_id: null,
  };
  const diff = Object.keys(body).filter((key) => !matches(body[key], guild[key]));
  const community = guild.features.includes('COMMUNITY');
  if (!community) {
    body.features = [...guild.features, 'COMMUNITY'];
    diff.push('enable Community');
  }
  if (!guild.icon) {
    body.icon = `data:image/png;base64,${readFileSync(asset(s.icon)).toString('base64')}`;
    diff.push('icon');
  }
  if (!diff.length) return same();
  change(`update server settings: ${diff.join(', ')}`);
  if (Object.values(body).some(isPlaceholder)) return;
  const updated = await call('patch', `/guilds/${G}`, { body, reason: 'Ylide setup' });
  if (updated) Object.assign(guild, updated);
}

// Discord keeps positions per kind of channel across the whole server and
// renumbers them when channels come and go (tickets do). Positions that start
// at 0 in every category therefore collide, and Discord may shuffle channels
// with equal positions. So the order is checked per category, and when it is
// off, every category, text-like and voice channel gets a server-wide unique
// position in sidebar order. Channels the spec does not know (tickets, ones
// added by hand) keep their order after ours in their category.
async function syncOrder(ctx) {
  const live = await rest.get(`/guilds/${G}/channels`);
  const categoryIds = spec.categories.map((c) => ctx.cat[c.key]);
  const channelIds = spec.categories.flatMap((c) => c.channels.map((ch) => ctx.ch[ch.key]));
  if ([...categoryIds, ...channelIds].some(isPlaceholder)) return change('order categories and channels');

  const isVoice = (c) => c.type === 2 || c.type === 13;
  const sequence = (wantedIds, pool) => [...wantedIds.filter((id) => pool.some((c) => c.id === id)), ...sidebarOrder(pool.filter((c) => !wantedIds.includes(c.id))).map((c) => c.id)];
  const byId = new Map(live.map((c) => [c.id, c]));
  const strictlyRising = (ids) => ids.every((id, i) => i === 0 || byId.get(id).position > byId.get(ids[i - 1]).position);

  const cats = sequence(categoryIds, live.filter((c) => c.type === 4));
  const groups = [];
  for (const parent of [null, ...cats]) {
    const specCategory = spec.categories.find((c) => ctx.cat[c.key] === parent);
    const inside = live.filter((c) => c.type !== 4 && (c.parent_id ?? null) === parent);
    for (const voice of [false, true]) {
      const ours = (specCategory?.channels ?? []).filter((c) => (c.type === 'voice') === voice).map((c) => ctx.ch[c.key]);
      groups.push({ voice, ids: sequence(ours, inside.filter((c) => isVoice(c) === voice)) });
    }
  }
  if (strictlyRising(cats) && groups.every((g) => strictlyRising(g.ids))) return same();

  const positions = cats.map((id, i) => ({ id, position: i }));
  for (const voice of [false, true]) {
    groups
      .filter((g) => g.voice === voice)
      .flatMap((g) => g.ids)
      .forEach((id, i) => positions.push({ id, position: i }));
  }
  change(`reorder ${positions.length} channels and categories`);
  await call('patch', `/guilds/${G}/channels`, { body: positions, reason: 'Ylide setup' });
}

function messageFiles(names) {
  return (names ?? []).map((key) => {
    const path = asset(`assets/${key}.png`);
    return { key, name: `${key}-${fileHash(path)}.png`, data: readFileSync(path) };
  });
}

async function syncMessages(ctx, botId) {
  const files = Object.fromEntries(messageFiles(['banner']).map((f) => [f.key, f.name]));
  const mctx = { ch: ctx.ch, emojis: ctx.emojis, files };
  for (const [key, build] of Object.entries(content)) {
    const channelId = ctx.ch[key];
    const desired = build(mctx);
    if (isPlaceholder(channelId)) {
      change(`post ${desired.length} message(s) in #${key}`);
      continue;
    }
    const recent = await rest.get(`/channels/${channelId}/messages`, { query: new URLSearchParams({ limit: '50' }) });
    const ours = recent.filter((m) => m.author.id === botId).reverse();
    for (let i = 0; i < desired.length; i++) {
      const { files: fileKeys, ...body } = desired[i];
      const uploads = messageFiles(fileKeys);
      const options = uploads.length
        ? { body: { ...body, attachments: uploads.map((f, n) => ({ id: n, filename: f.name })) }, files: uploads.map((f) => ({ name: f.name, data: f.data })) }
        : { body };
      const live = ours[i];
      if (!live) {
        change(`post message ${i + 1} in #${key}`);
        await call('post', `/channels/${channelId}/messages`, options);
        continue;
      }
      const isV2 = (live.flags & IS_COMPONENTS_V2) === IS_COMPONENTS_V2;
      if (isV2 && matches(body.components, live.components)) {
        same();
        continue;
      }
      change(`update message ${i + 1} in #${key}`);
      await call('patch', `/channels/${channelId}/messages/${live.id}`, options);
    }
    for (const extra of ours.slice(desired.length)) {
      change(`delete old bot message in #${key}`);
      await call('delete', `/channels/${channelId}/messages/${extra.id}`);
    }
  }
}

async function syncOnboarding(ctx, guild) {
  if (!guild.features.includes('COMMUNITY')) return change('set up onboarding (after Community is on)');
  const live = await rest.get(`/guilds/${G}/onboarding`);
  let n = 0;
  const prompts = spec.onboarding.prompts.map((p) => {
    const liveP = live.prompts.find((lp) => lp.title === p.title);
    return {
      id: liveP?.id ?? fakeSnowflake(++n),
      type: 0,
      title: p.title,
      single_select: p.singleSelect,
      required: p.required,
      in_onboarding: true,
      options: p.options.map((o) => {
        const liveO = liveP?.options.find((lo) => lo.title === o.title);
        return {
          id: liveO?.id ?? fakeSnowflake(++n),
          title: o.title,
          description: o.description,
          emoji_name: o.emoji ?? null,
          emoji_id: null,
          emoji_animated: false,
          channel_ids: o.channels.map((k) => ctx.ch[k]),
          role_ids: o.roles.map((k) => ctx.roles[k]),
        };
      }),
    };
  });
  const body = { prompts, default_channel_ids: spec.onboarding.defaultChannels.map((k) => ctx.ch[k]), enabled: true, mode: 0 };
  const samePrompts =
    live.prompts.length === prompts.length &&
    prompts.every((p, i) => {
      const lp = live.prompts[i];
      return (
        lp.title === p.title &&
        lp.single_select === p.single_select &&
        lp.required === p.required &&
        lp.options.length === p.options.length &&
        p.options.every((o, j) => {
          const lo = lp.options[j];
          return (
            lo.title === o.title &&
            (lo.description ?? '') === o.description &&
            (lo.emoji?.name ?? null) === o.emoji_name &&
            JSON.stringify([...lo.channel_ids].sort()) === JSON.stringify([...o.channel_ids].sort()) &&
            JSON.stringify([...lo.role_ids].sort()) === JSON.stringify([...o.role_ids].sort())
          );
        })
      );
    });
  const sameChannels = JSON.stringify([...live.default_channel_ids].sort()) === JSON.stringify([...body.default_channel_ids].sort());
  if (samePrompts && sameChannels && live.enabled && live.mode === 0) return same();
  change('update onboarding (questions and default channels)');
  if ([...body.default_channel_ids, ...prompts.flatMap((p) => p.options.flatMap((o) => [...o.channel_ids, ...o.role_ids]))].some(isPlaceholder)) return;
  await call('put', `/guilds/${G}/onboarding`, { body, reason: 'Ylide setup' });
}

async function syncAutomod(ctx) {
  const live = isPlaceholder(ctx.ch.modLog) ? [] : await rest.get(`/guilds/${G}/auto-moderation/rules`);
  for (const rule of spec.automod) {
    const actions = [
      { type: 1, metadata: { custom_message: 'Blocked by the rules of the Ylide server.' } },
      { type: 2, metadata: { channel_id: ctx.ch.modLog } },
    ];
    if (rule.timeout) actions.push({ type: 3, metadata: { duration_seconds: rule.timeout } });
    const body = {
      name: rule.name,
      event_type: 1,
      trigger_type: rule.trigger,
      trigger_metadata: rule.metadata,
      actions,
      enabled: true,
      exempt_roles: spec.automodExempt.roles.map((k) => ctx.roles[k]),
      exempt_channels: spec.automodExempt.channels.map((k) => ctx.ch[k]),
    };
    const existing = live.find((r) => r.name === rule.name);
    if (!existing) {
      change(`create AutoMod rule "${rule.name}"`);
      if (!JSON.stringify(body).includes('"new:')) await call('post', `/guilds/${G}/auto-moderation/rules`, { body, reason: 'Ylide setup' });
      continue;
    }
    const sorted = (a) => [...a].sort();
    const equal =
      matches({ ...body, exempt_roles: undefined, exempt_channels: undefined }, existing) &&
      JSON.stringify(sorted(body.exempt_roles)) === JSON.stringify(sorted(existing.exempt_roles)) &&
      JSON.stringify(sorted(body.exempt_channels)) === JSON.stringify(sorted(existing.exempt_channels));
    if (equal) {
      same();
      continue;
    }
    change(`update AutoMod rule "${rule.name}"`);
    const { trigger_type, ...patch } = body;
    await call('patch', `/guilds/${G}/auto-moderation/rules/${existing.id}`, { body: patch, reason: 'Ylide setup' });
  }
}

// A permanent invite to #welcome for the website's Discord button. Reused once
// the bot has made one; the URL is printed at the end.
async function syncInvite(ctx) {
  const channelId = ctx.ch[spec.invite.channel];
  if (isPlaceholder(channelId)) return change('create a permanent invite');
  const invites = await rest.get(`/guilds/${G}/invites`);
  const existing = invites.find((i) => i.inviter?.id === ctx.botId && i.channel?.id === channelId && i.max_age === 0 && i.max_uses === 0 && !i.temporary);
  if (existing) {
    same();
    return `https://discord.gg/${existing.code}`;
  }
  change(`create a permanent invite to #${spec.invite.channel}`);
  const created = await call('post', `/channels/${channelId}/invites`, { body: { max_age: 0, max_uses: 0, temporary: false, unique: true }, reason: 'Ylide setup: website invite' });
  return created ? `https://discord.gg/${created.code}` : null;
}

async function syncCommands() {
  const live = await rest.get(`/applications/${env.appId}/guilds/${G}/commands`);
  const equal = live.length === commands.length && commands.every((c) => matches(c, live.find((l) => l.name === c.name)));
  if (equal) return same();
  change(`register ${commands.length} slash command(s)`);
  await call('put', `/applications/${env.appId}/guilds/${G}/commands`, { body: commands });
}

async function removeDefaults() {
  const live = await rest.get(`/guilds/${G}/channels`);
  // Discord names the starter channels in the creator's language.
  const starterVoice = live.find((c) => c.type === 2 && ['General', 'Allgemein'].includes(c.name));
  if (starterVoice) {
    change(`delete the starter voice channel "${starterVoice.name}"`);
    await call('delete', `/channels/${starterVoice.id}`);
  }
  for (const name of ['Text Channels', 'Voice Channels', 'Textkanäle', 'Sprachkanäle']) {
    const category = live.find((c) => c.type === 4 && c.name === name);
    if (!category) continue;
    const children = live.filter((c) => c.parent_id === category.id && c.id !== starterVoice?.id);
    if (children.length) {
      console.log(`  keeping category "${name}": it still has ${children.length} channel(s)`);
      continue;
    }
    change(`delete the empty starter category "${name}"`);
    await call('delete', `/channels/${category.id}`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(dryRun ? 'Dry run: nothing is changed.\n' : 'Setting up the Ylide server.\n');
  const me = await rest.get('/users/@me');
  const guild = await rest.get(`/guilds/${G}`);
  const botMember = await rest.get(`/guilds/${G}/members/${me.id}`);
  console.log(`Server "${guild.name}", bot ${me.username}\n`);
  if ((permissionsOf(guild, botMember) & ADMIN) !== ADMIN) {
    throw new Error('The bot needs the Administrator permission for the setup (see README: invite link).');
  }

  // Categories and channels have separate key spaces (the Help category holds the #help forum).
  const ctx = { botId: me.id, cat: {}, ch: {}, roles: {}, emojis: {} };
  await syncProfile(me);
  ctx.emojis = await syncEmojis();
  ctx.roles = await syncRoles(guild, botMember);
  await syncOwnerRole(guild, ctx.roles);

  const live = await rest.get(`/guilds/${G}/channels`);
  // Text and voice channels first: Community needs #rules and #mod-log to exist.
  await syncChannels(ctx, live, { types: new Set([4, 0, 2]) });
  await syncGuild(guild, ctx);
  // Announcement channels and forums need Community.
  await syncChannels(ctx, live, { types: new Set([5, 15]) });
  await syncOrder(ctx);
  await syncMessages(ctx, me.id);
  await syncOnboarding(ctx, guild);
  await syncAutomod(ctx);
  await syncCommands();
  const invite = await syncInvite(ctx);
  if (args.has('--remove-default-channels')) await removeDefaults();

  console.log(`\n${changes.length} change(s)${dryRun ? ' planned' : ''}, ${unchanged} item(s) already up to date.`);
  if (invite) console.log(`Invite link for the website: ${invite}`);
  if (!guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED') && !dryRun) {
    console.log('\nLast step by hand: Server Settings > Safety Setup > "Members must accept rules before they can talk or DM" (see README).');
  }
}

main().catch((error) => {
  // DiscordAPIError messages contain the route and Discord's reason, never the token.
  console.error(`\nSetup failed: ${error.message}`);
  if (error.rawError?.errors) console.error(JSON.stringify(error.rawError.errors, null, 2));
  process.exit(1);
});
