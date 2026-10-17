// Announces new Ylide versions in #releases. The bot reads ylide.app's update
// manifest (version.js); when a version newer than the last announced one
// appears, it posts one message, pings the Release pings role and publishes
// the message to servers that follow the announcement channel.
//
// No version is ever announced twice: the last announced version is saved
// (state.js), and before posting the bot also looks for its own post of that
// version in the channel. On the very first start it only records the
// current version, unless `deploy.mjs --release-baseline <version>` asked to
// announce everything after an older one.

import { ChannelType, MessageFlags } from 'discord.js';
import { colors, links } from '../theme.js';
import { button, container, row, separator, text } from '../components.js';
import { allChannels, roles as roleSpec } from '../spec.js';
import { log } from './log.js';

// When the GitHub release page is not there yet, wait this long for it before
// posting with a link to the repository instead.
const GITHUB_GRACE = 30 * 60 * 1000;
const NOTES_MAX = 1500;

/** Compares "1.2.3" versions numerically: negative, 0 or positive. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * What to do with the manifest's version, given the saved state:
 * "record" (first start: remember it without posting), "announce" or "skip".
 */
export function decide(version, { lastRelease, releaseBaseline }) {
  const reference = releaseBaseline ?? lastRelease;
  if (!reference) return 'record';
  return compareVersions(version, reference) > 0 ? 'announce' : 'skip';
}

const GERMAN = /\b(und|oder|der|die|das|den|dem|des|ist|sind|nicht|mit|für|jetzt|du|dir|dich|kannst|wird|werden|wurde|ein|eine|einen|eines|beim|auf|zu|auch|sich|lassen|lässt|neu|neue|wenn|bei|im|über|nach|noch|schneller|leichter)\b|[äöüß]/gi;
const ENGLISH = /\b(the|and|or|you|your|can|now|is|are|with|for|when|it|its|be|new|a|an|of|to|in|from|faster|easier|no|longer)\b/gi;

function language(sentence) {
  const de = (sentence.match(GERMAN) ?? []).length;
  const en = (sentence.match(ENGLISH) ?? []).length;
  return de > en ? 'de' : en > de ? 'en' : null;
}

/**
 * The release notes are one string, German first and then English. Splits
 * them at the first English sentence that only English follows. Returns
 * { en, de }; when the notes do not split that cleanly, all of it is `en`
 * (or `de` when it is clearly German only).
 */
export function splitNotes(notes) {
  const sentences = String(notes ?? '')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/)
    .filter(Boolean);
  if (!sentences.length) return { en: '', de: '' };
  const langs = sentences.map(language);
  // Sentences without a clear signal take the language of the one before.
  for (let i = 0; i < langs.length; i++) langs[i] ??= langs[i - 1] ?? null;
  const firstEn = langs.indexOf('en');
  const all = sentences.join(' ');
  if (firstEn === -1) return langs.includes('de') ? { en: '', de: all } : { en: all, de: '' };
  const before = langs.slice(0, firstEn);
  const after = langs.slice(firstEn);
  if (before.every((l) => l === 'de') && after.every((l) => l === 'en')) {
    return { en: sentences.slice(firstEn).join(' '), de: sentences.slice(0, firstEn).join(' ') };
  }
  return { en: all, de: '' };
}

const clip = (s) => (s.length > NOTES_MAX ? `${s.slice(0, NOTES_MAX - 1).trimEnd()}…` : s);

/** The #releases post (Components V2). */
export function releasePost({ version, date, notes, githubUrl, pingRoleId, emojis }) {
  const { en, de } = splitNotes(notes);
  const mark = emojis.ylide_mark ? `<:ylide_mark:${emojis.ylide_mark}> ` : '';
  const when = date ? `Released <t:${Math.floor(date / 1000)}:D>` : 'New release';
  const blocks = [];
  if (en) blocks.push(text(`**What's new**\n${clip(en)}`));
  if (en && de) blocks.push(separator(false, false));
  if (de) blocks.push(text(`**Neu in dieser Version**\n${clip(de)}`));
  if (!en && !de) blocks.push(text('Bug fixes and improvements.'));
  return [
    container(
      colors.qubit,
      text(`## ${mark}Ylide ${version}\n-# ${when}`),
      separator(),
      ...blocks,
      separator(),
      row(button({ label: 'Download', url: links.website }), button({ label: 'GitHub', url: githubUrl })),
      text(`-# Ylide offers the update at its next start.${pingRoleId ? ` <@&${pingRoleId}>` : ''}`),
    ),
  ];
}

/** The GitHub release page of a version if it exists, else null. Network errors count as "not yet". */
export async function githubReleaseUrl(version, fetchImpl = fetch) {
  if (!links.github) return null;
  const repo = new URL(links.github).pathname.replace(/^\/|\/$/g, '');
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ylide-discord-bot' },
      signal: AbortSignal.timeout(10000),
    });
    return response.ok ? `${links.github}/releases/tag/v${version}` : null;
  } catch {
    return null;
  }
}

const releasesChannelName = allChannels().find((c) => c.key === 'releases').name;
const pingRoleName = roleSpec.find((r) => r.key === 'releasePings').name;

export class ReleaseAnnouncer {
  constructor({ state, guild, emojis, fetchGithub = githubReleaseUrl }) {
    this.state = state;
    this.guild = guild;
    this.emojis = emojis;
    this.fetchGithub = fetchGithub;
    this.waitingSince = new Map();
    this.busy = false;
  }

  /** Called with every successful read of the manifest. Never throws. */
  async check(release) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.handle(release);
    } catch (error) {
      log(`release announcement failed: ${error.message}`);
    } finally {
      this.busy = false;
    }
  }

  async handle({ version, notes, date }) {
    const action = decide(version, { lastRelease: this.state.lastRelease, releaseBaseline: this.state.releaseBaseline });
    if (action === 'skip') return;
    if (action === 'record') {
      this.state.setLastRelease(version);
      log(`release ${version} recorded as known (first start, nothing posted)`);
      return;
    }

    let githubUrl = await this.fetchGithub(version);
    if (!githubUrl) {
      const since = this.waitingSince.get(version) ?? Date.now();
      this.waitingSince.set(version, since);
      if (Date.now() - since < GITHUB_GRACE) return;
      githubUrl = links.github ?? links.website;
    }

    const channel = this.guild.channels.cache.find((c) => c.name === releasesChannelName && c.type !== ChannelType.GuildCategory);
    if (!channel) throw new Error('the #releases channel is missing; run the setup');
    if (await this.alreadyPosted(channel, version)) {
      this.state.setLastRelease(version);
      return;
    }
    const role = this.guild.roles.cache.find((r) => r.name === pingRoleName);
    const message = await channel.send({
      components: releasePost({ version, date, notes, githubUrl, pingRoleId: role?.id, emojis: this.emojis }),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { roles: role ? [role.id] : [] },
    });
    this.state.setLastRelease(version);
    this.waitingSince.delete(version);
    log(`release ${version} announced`);
    if (channel.type === ChannelType.GuildAnnouncement) {
      await message.crosspost().catch((error) => log(`release ${version} not published to followers: ${error.message}`));
    }
  }

  /** True when the bot's recent messages in #releases already announce this version. */
  async alreadyPosted(channel, version) {
    const recent = await channel.messages.fetch({ limit: 20 });
    const heading = new RegExp(`Ylide ${version.replace(/\./g, '\\.')}\\b`);
    return recent.some((m) => m.author.id === channel.client.user.id && heading.test(JSON.stringify(m.components.map((c) => c.toJSON()))));
  }
}
