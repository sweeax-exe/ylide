// The messages the ticket bot posts, as Components V2 JSON. Pure functions,
// so they can be tested without Discord.

import { colors } from '../theme.js';
import { button, container, emoji, row, separator, text, ButtonStyle } from '../components.js';
import { ticketTypes } from './forms.js';

export const DELETE_AFTER_HOURS = 48;

const em = (emojis, name) => (emojis[name] ? `<:${name}:${emojis[name]}> ` : '');
export const pad = (n) => String(n).padStart(4, '0');
export const ticketName = (type, number) => `${ticketTypes[type].prefix}-${pad(number)}`;

/** Parses "bug-0007" into { type, number }, or null for other channels. */
export function parseTicketName(name) {
  const m = /^([a-z]+)-(\d{4,})$/.exec(name ?? '');
  if (!m) return null;
  const type = Object.keys(ticketTypes).find((t) => ticketTypes[t].prefix === m[1]);
  return type ? { type, number: Number(m[2]) } : null;
}

/** The topic is written once, when the ticket opens; it records who opened it. */
export const ticketTopic = (type, ownerId) => `${ticketTypes[type].title} · opened by <@${ownerId}>`;
export const ownerFromTopic = (topic) => /<@!?(\d+)>/.exec(topic ?? '')?.[1] ?? null;

const fieldText = (fields) => fields.map((f) => `**${f.label}**\n${f.value || '-# Not given'}`).join('\n\n');

export function headerButtons(emojis, { claimedBy, claimedName, closed } = {}) {
  return row(
    claimedBy
      ? button({ id: `ticket:claimed:${claimedBy}`, label: `Claimed by ${claimedName}`.slice(0, 80), emoji: emoji(emojis, 'ylide_claim'), disabled: true })
      : button({ id: 'ticket:claim', label: 'Claim', emoji: emoji(emojis, 'ylide_claim'), disabled: closed }),
    button({ id: 'ticket:close', label: 'Close', style: ButtonStyle.danger, emoji: emoji(emojis, 'ylide_close'), disabled: closed }),
  );
}

/** The first message in a ticket channel. */
export function ticketHeader({ type, number, ownerId, supportRoleId, fields, emojis, openedAt }) {
  const t = ticketTypes[type];
  const ping = supportRoleId ? `<@&${supportRoleId}> will reply here.` : 'The team will reply here.';
  return [
    container(
      t.color,
      text(`## ${em(emojis, t.emoji)}${t.title} · #${pad(number)}`),
      text(`Opened by <@${ownerId}> <t:${Math.floor(openedAt / 1000)}:R>. ${ping}`),
      separator(),
      text(fieldText(fields)),
      separator(),
      text("-# Don't share passwords, tokens or other secrets here. Close the ticket once your question is answered."),
      headerButtons(emojis),
    ),
  ];
}

/** Replaces the action row of a header (found by its Close button). */
export function withHeaderButtons(components, buttonsRow) {
  return components.map((c) => {
    if (c.type !== 17) return c;
    return { ...c, components: c.components.map((inner) => (inner.type === 1 && inner.components.some((b) => b.custom_id === 'ticket:close') ? buttonsRow : inner)) };
  });
}

/** Who claimed the ticket, read back from the header's disabled button. */
export function claimedByOf(components) {
  let found = null;
  const walk = (list) => {
    for (const c of list ?? []) {
      const m = /^ticket:claimed:(\d+)$/.exec(c.custom_id ?? '');
      if (m) found = m[1];
      walk(c.components);
    }
  };
  walk(components);
  return found;
}

export function closedPanel({ closedBy, emojis, closedAt }) {
  return [
    container(
      colors.text3,
      text(
        `### ${em(emojis, 'ylide_close')}Ticket closed\n` +
          `Closed by <@${closedBy}> <t:${Math.floor(closedAt / 1000)}:R>. ` +
          `This channel is deleted ${DELETE_AFTER_HOURS} hours after the last message; a transcript stays with the team.`,
      ),
      row(
        button({ id: 'ticket:transcript', label: 'Transcript', emoji: emoji(emojis, 'ylide_transcript') }),
        button({ id: 'ticket:reopen', label: 'Reopen', emoji: emoji(emojis, 'ylide_reopen') }),
        button({ id: 'ticket:delete', label: 'Delete now', style: ButtonStyle.danger, emoji: emoji(emojis, 'ylide_delete') }),
      ),
    ),
  ];
}

export function reopenedPanel({ reopenedBy, emojis }) {
  return [container(colors.qubit, text(`### ${em(emojis, 'ylide_reopen')}Ticket reopened\nReopened by <@${reopenedBy}>.`))];
}

export const note = (content, accent = colors.qubit) => [container(accent, text(content))];

/** One line in #ticket-log. */
export function logEntry({ action, channelId, name, type, actorId, ownerId, emojis }) {
  const t = ticketTypes[type];
  const where = channelId ? `<#${channelId}>` : `\`${name}\``;
  const owner = ownerId && ownerId !== actorId ? ` · opened by <@${ownerId}>` : '';
  const accent = { opened: t.color, claimed: colors.success, closed: colors.text3, reopened: colors.qubit, deleted: colors.text3 }[action];
  return [container(accent, text(`${em(emojis, t.emoji)}**${action[0].toUpperCase()}${action.slice(1)}** ${where} · ${t.title} · by <@${actorId}>${owner}`))];
}

export function ideaPost({ ownerId, fields, emojis }) {
  const get = (id) => fields.find((f) => f.id === id)?.value ?? '';
  return [
    container(
      colors.brass,
      text(`${em(emojis, 'ylide_idea')}Suggested by <@${ownerId}>`),
      separator(),
      text(`**The problem**\n${get('problem')}\n\n**The idea**\n${get('idea')}`),
      separator(),
      text('-# Vote with 👍 and add your use case below. The team sets the status tag.'),
    ),
  ];
}
