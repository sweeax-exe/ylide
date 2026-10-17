// The ticket system: panel buttons open a form, the form opens a private
// channel, and the team claims, closes, reopens or deletes it from there.
//
// State lives in Discord, not on disk:
//   - type and number: the channel name ("bug-0007")
//   - who opened it:   the channel topic, written once
//   - who claimed it:  the header's disabled "Claimed by" button
//   - open or closed:  the category the channel is in
// Only the ticket counter is saved (state.js).

import { ChannelType, MessageFlags, OverwriteType, SnowflakeUtil } from 'discord.js';
import { categories, roles as roleSpec, allChannels } from '../spec.js';
import { ticketMember } from '../permissions.js';
import { ticketTypes, modal, readForm } from './forms.js';
import {
  DELETE_AFTER_HOURS,
  claimedByOf,
  closedPanel,
  headerButtons,
  ideaPost,
  logEntry,
  note,
  ownerFromTopic,
  parseTicketName,
  reopenedPanel,
  ticketHeader,
  ticketName,
  ticketTopic,
  withHeaderButtons,
} from './cards.js';
import { renderTranscript } from './transcript.js';
import { latestVersion } from './version.js';
import { log } from './log.js';

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_FILE = 10 * 1024 * 1024;
const IDEA_COOLDOWN = 10 * 60 * 1000;

const categoryName = (key) => categories.find((c) => c.key === key).name;
const channelName = (key) => allChannels().find((c) => c.key === key).name;
const roleName = (key) => roleSpec.find((r) => r.key === key).name;

export class Tickets {
  constructor({ state, emojis }) {
    this.state = state;
    this.emojis = emojis;
    this.ideaCooldown = new Map();
  }

  // --- lookups --------------------------------------------------------------

  category(guild, key) {
    const name = categoryName(key).toLowerCase();
    return guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name);
  }

  channel(guild, key) {
    const name = channelName(key);
    return guild.channels.cache.find((c) => c.name === name && c.type !== ChannelType.GuildCategory);
  }

  role(guild, key) {
    return guild.roles.cache.find((r) => r.name === roleName(key));
  }

  isStaff(member) {
    if (member.permissions.has('Administrator')) return true;
    const staff = ['support', 'moderator', 'maintainer'].map((k) => this.role(member.guild, k)?.id).filter(Boolean);
    return member.roles.cache.some((r) => staff.includes(r.id));
  }

  /** The ticket a channel belongs to, or null. */
  ticketOf(channel) {
    if (!channel?.guild) return null;
    const parsed = parseTicketName(channel.name);
    const open = this.category(channel.guild, 'openTickets');
    const closed = this.category(channel.guild, 'closedTickets');
    if (!parsed || ![open?.id, closed?.id].includes(channel.parentId)) return null;
    return { ...parsed, ownerId: ownerFromTopic(channel.topic), closed: channel.parentId === closed?.id };
  }

  async log(guild, entry) {
    const channel = this.channel(guild, 'ticketLog');
    if (!channel) return;
    await channel.send({ components: logEntry({ ...entry, emojis: this.emojis }), flags: V2, allowedMentions: { parse: [] } });
  }

  // --- panel and forms ------------------------------------------------------

  async openForm(interaction, type) {
    if (type !== 'idea') {
      const existing = this.openTicketOf(interaction.guild, interaction.user.id, type);
      if (existing) {
        return interaction.reply({ content: `You already have an open ${ticketTypes[type].title.toLowerCase()}: ${existing}`, flags: EPHEMERAL });
      }
    }
    return interaction.showModal(modal(type, { version: latestVersion() }));
  }

  openTicketOf(guild, userId, type) {
    const open = this.category(guild, 'openTickets');
    if (!open) return null;
    return guild.channels.cache.find((c) => c.parentId === open.id && parseTicketName(c.name)?.type === type && ownerFromTopic(c.topic) === userId) ?? null;
  }

  async submitForm(interaction, type, { read, files }) {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild;
    const owner = interaction.user;
    const existing = this.openTicketOf(guild, owner.id, type);
    if (existing) return interaction.editReply(`You already have an open ${ticketTypes[type].title.toLowerCase()}: ${existing}`);

    const open = this.category(guild, 'openTickets');
    if (!open) throw new Error('the "Open tickets" category is missing; run the setup');
    const number = this.state.nextTicket();
    const name = ticketName(type, number);
    const overwrites = open.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
    overwrites.push({ id: owner.id, type: OverwriteType.Member, allow: ticketMember, deny: 0n });
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: open.id,
      topic: ticketTopic(type, owner.id),
      permissionOverwrites: overwrites,
      reason: `Ticket ${name}`,
    });

    const support = this.role(guild, 'support');
    await channel.send({
      components: ticketHeader({ type, number, ownerId: owner.id, supportRoleId: support?.id, fields: readForm(type, read), emojis: this.emojis, openedAt: Date.now() }),
      flags: V2,
      allowedMentions: { users: [owner.id], roles: support ? [support.id] : [] },
    });
    await this.forwardFiles(channel, owner.id, files);
    await this.log(guild, { action: 'opened', channelId: channel.id, type, actorId: owner.id });
    log(`ticket ${name} opened`);
    return interaction.editReply(`Your ticket is open: ${channel}`);
  }

  /** Re-uploads files from the form into the ticket; too large ones are linked. */
  async forwardFiles(channel, ownerId, files) {
    if (!files?.length) return;
    const uploads = [];
    const links = [];
    for (const file of files) {
      if (file.size > MAX_FILE) {
        links.push(`[${file.name}](${file.url})`);
        continue;
      }
      try {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(30000) });
        uploads.push({ attachment: Buffer.from(await response.arrayBuffer()), name: file.name });
      } catch {
        links.push(`[${file.name}](${file.url})`);
      }
    }
    const content = `Attached by <@${ownerId}>` + (links.length ? `\nToo large to copy, Discord link (expires): ${links.join(', ')}` : '');
    await channel.send({ content, files: uploads, allowedMentions: { parse: [] } });
  }

  async submitIdea(interaction, { read }) {
    await interaction.deferReply({ flags: EPHEMERAL });
    const userId = interaction.user.id;
    const last = this.ideaCooldown.get(userId) ?? 0;
    if (Date.now() - last < IDEA_COOLDOWN) {
      return interaction.editReply(`You just posted an idea. Please wait <t:${Math.floor((last + IDEA_COOLDOWN) / 1000)}:R> before posting the next one.`);
    }
    const forum = this.channel(interaction.guild, 'ideas');
    if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('the #ideas forum is missing; run the setup');
    const fields = readForm('idea', read);
    const title = fields.find((f) => f.id === 'title').value;
    const area = fields.find((f) => f.id === 'area').value;
    const tags = forum.availableTags.filter((t) => t.name === 'New' || t.name === area).map((t) => t.id);
    const thread = await forum.threads.create({
      name: title.slice(0, 100),
      appliedTags: tags,
      message: { components: ideaPost({ ownerId: userId, fields, emojis: this.emojis }), flags: V2, allowedMentions: { users: [userId] } },
      reason: 'Feature idea from the ticket panel',
    });
    await thread.members.add(userId).catch(() => {});
    this.ideaCooldown.set(userId, Date.now());
    log('idea posted');
    return interaction.editReply(`Thanks! Your idea is posted: ${thread}`);
  }

  // --- buttons in the ticket ------------------------------------------------

  async claim(interaction) {
    const ticket = this.ticketOf(interaction.channel);
    if (!ticket) return;
    if (!this.isStaff(interaction.member)) return interaction.reply({ content: 'Only the team can claim tickets.', flags: EPHEMERAL });
    const components = interaction.message.components.map((c) => c.toJSON());
    if (claimedByOf(components)) return interaction.reply({ content: 'This ticket is already claimed.', flags: EPHEMERAL });
    const buttons = headerButtons(this.emojis, { claimedBy: interaction.user.id, claimedName: interaction.member.displayName });
    await interaction.update({ components: withHeaderButtons(components, buttons) });
    await interaction.channel.send({ components: note(`<@${interaction.user.id}> is taking care of this ticket.`), flags: V2, allowedMentions: { parse: [] } });
    await this.log(interaction.guild, { action: 'claimed', channelId: interaction.channel.id, type: ticket.type, actorId: interaction.user.id, ownerId: ticket.ownerId });
    log(`ticket ${interaction.channel.name} claimed`);
  }

  async askClose(interaction) {
    const ticket = this.ticketOf(interaction.channel);
    if (!ticket || ticket.closed) return;
    if (!this.isStaff(interaction.member) && interaction.user.id !== ticket.ownerId) {
      return interaction.reply({ content: 'Only the person who opened the ticket or the team can close it.', flags: EPHEMERAL });
    }
    return interaction.reply({
      content: 'Close this ticket? You can still read it afterwards, and the team can reopen it.',
      components: [{ type: 1, components: [{ type: 2, style: 4, custom_id: 'ticket:close-confirm', label: 'Close ticket' }] }],
      flags: EPHEMERAL,
    });
  }

  /** Closes the ticket in the interaction's channel (button or /ticket close). */
  async close(interaction) {
    const channel = interaction.channel;
    const ticket = this.ticketOf(channel);
    if (!ticket || ticket.closed) return interaction.reply({ content: 'This ticket is already closed.', flags: EPHEMERAL });
    if (!this.isStaff(interaction.member) && interaction.user.id !== ticket.ownerId) {
      return interaction.reply({ content: 'Only the person who opened the ticket or the team can close it.', flags: EPHEMERAL });
    }
    if (interaction.isButton()) await interaction.update({ content: 'Closing the ticket…', components: [] });
    else await interaction.reply({ content: 'Closing the ticket…', flags: EPHEMERAL });

    const closed = this.category(interaction.guild, 'closedTickets');
    await channel.setParent(closed.id, { lockPermissions: false, reason: 'Ticket closed' });
    await this.setMembersCanWrite(channel, false);
    await this.updateHeader(channel, { closed: true });
    await channel.send({ components: closedPanel({ closedBy: interaction.user.id, emojis: this.emojis, closedAt: Date.now() }), flags: V2, allowedMentions: { parse: [] } });
    await this.log(interaction.guild, { action: 'closed', channelId: channel.id, type: ticket.type, actorId: interaction.user.id, ownerId: ticket.ownerId });
    log(`ticket ${channel.name} closed`);
    await interaction.editReply({ content: 'The ticket is closed.', components: [] }).catch(() => {});
  }

  async reopen(interaction) {
    const channel = interaction.channel;
    const ticket = this.ticketOf(channel);
    if (!ticket?.closed) return;
    if (!this.isStaff(interaction.member)) return interaction.reply({ content: 'Only the team can reopen tickets.', flags: EPHEMERAL });
    await interaction.update({ components: reopenedPanel({ reopenedBy: interaction.user.id, emojis: this.emojis }) });
    const open = this.category(interaction.guild, 'openTickets');
    await channel.setParent(open.id, { lockPermissions: false, reason: 'Ticket reopened' });
    await this.setMembersCanWrite(channel, true);
    await this.updateHeader(channel, { closed: false });
    await this.log(interaction.guild, { action: 'reopened', channelId: channel.id, type: ticket.type, actorId: interaction.user.id, ownerId: ticket.ownerId });
    log(`ticket ${channel.name} reopened`);
  }

  async remove(interaction) {
    const ticket = this.ticketOf(interaction.channel);
    if (!ticket?.closed) return;
    if (!this.isStaff(interaction.member)) return interaction.reply({ content: 'Only the team can delete tickets.', flags: EPHEMERAL });
    await interaction.update({ components: note('Deleting this ticket…', 0x808ca6) });
    await this.deleteTicket(interaction.channel, interaction.user.id);
  }

  async sendTranscript(interaction) {
    const ticket = this.ticketOf(interaction.channel);
    if (!ticket) return;
    await interaction.deferReply({ flags: EPHEMERAL });
    const file = await this.transcript(interaction.channel, ticket);
    return interaction.editReply({ content: 'Here is the transcript of this ticket. Only you can see this message.', files: [file] });
  }

  // --- slash command --------------------------------------------------------

  async command(interaction) {
    const ticket = this.ticketOf(interaction.channel);
    if (!this.isStaff(interaction.member)) return interaction.reply({ content: 'This command is for the team.', flags: EPHEMERAL });
    if (!ticket) return interaction.reply({ content: 'Use this command inside a ticket channel.', flags: EPHEMERAL });
    const sub = interaction.options.getSubcommand();
    if (sub === 'close') return this.close(interaction);
    const user = interaction.options.getUser('user', true);
    if (sub === 'add') {
      const allow = ticket.closed ? { ViewChannel: true, ReadMessageHistory: true } : { ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true, EmbedLinks: true, AddReactions: true };
      await interaction.channel.permissionOverwrites.edit(user.id, allow, { reason: 'Added to ticket' });
      return interaction.reply({ components: note(`<@${interaction.user.id}> added <@${user.id}> to this ticket.`), flags: V2, allowedMentions: { users: [user.id] } });
    }
    if (sub === 'remove') {
      if (user.id === ticket.ownerId) return interaction.reply({ content: 'The person who opened the ticket stays in it. Close the ticket instead.', flags: EPHEMERAL });
      await interaction.channel.permissionOverwrites.delete(user.id, 'Removed from ticket');
      return interaction.reply({ components: note(`<@${interaction.user.id}> removed <@${user.id}> from this ticket.`), flags: V2, allowedMentions: { parse: [] } });
    }
  }

  // --- shared ---------------------------------------------------------------

  async setMembersCanWrite(channel, canWrite) {
    const botId = channel.client.user.id;
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== OverwriteType.Member || overwrite.id === botId) continue;
      await channel.permissionOverwrites.edit(
        overwrite.id,
        { ViewChannel: true, ReadMessageHistory: true, SendMessages: canWrite, AttachFiles: canWrite, AddReactions: canWrite },
        { reason: canWrite ? 'Ticket reopened' : 'Ticket closed' },
      );
    }
  }

  /** Finds the bot's first message in the ticket and updates its buttons. */
  async updateHeader(channel, { closed }) {
    const messages = await channel.messages.fetch({ after: '0', limit: 5 });
    const header = [...messages.values()]
      .sort((x, y) => x.createdTimestamp - y.createdTimestamp)
      .find((m) => m.author.id === channel.client.user.id && m.components.length);
    if (!header) return;
    const components = header.components.map((c) => c.toJSON());
    const claimedBy = claimedByOf(components);
    const claimedName = claimedBy ? (await channel.guild.members.fetch(claimedBy).catch(() => null))?.displayName ?? 'the team' : null;
    await header.edit({ components: withHeaderButtons(components, headerButtons(this.emojis, { claimedBy, claimedName, closed })) });
  }

  async transcript(channel, ticket) {
    const all = [];
    let before;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      all.push(...batch.values());
      if (batch.size < 100) break;
      before = batch.last().id;
    }
    all.reverse();
    const users = {};
    for (const m of all) {
      users[m.author.id] = m.member?.displayName ?? m.author.globalName ?? m.author.username;
      for (const u of m.mentions.users.values()) users[u.id] ??= u.globalName ?? u.username;
    }
    const owner = ticket.ownerId ? (users[ticket.ownerId] ?? (await channel.client.users.fetch(ticket.ownerId).catch(() => null))?.username ?? ticket.ownerId) : 'unknown';
    const names = {
      users,
      roles: Object.fromEntries(channel.guild.roles.cache.map((r) => [r.id, r.name])),
      channels: Object.fromEntries(channel.guild.channels.cache.map((c) => [c.id, c.name])),
    };
    const html = renderTranscript(
      { name: channel.name, title: ticketTypes[ticket.type].title, owner, opened: channel.createdTimestamp, closed: Date.now() },
      all.map((m) => ({
        author: users[m.author.id],
        bot: m.author.bot,
        time: m.createdTimestamp,
        content: m.content,
        components: m.components.map((c) => c.toJSON()),
        attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
      })),
      names,
    );
    return { attachment: Buffer.from(html, 'utf8'), name: `transcript-${channel.name}.html` };
  }

  async deleteTicket(channel, actorId) {
    const ticket = this.ticketOf(channel);
    if (!ticket) return;
    const logChannel = this.channel(channel.guild, 'ticketLog');
    const file = await this.transcript(channel, ticket);
    if (logChannel) {
      await logChannel.send({
        components: logEntry({ action: 'deleted', name: channel.name, type: ticket.type, actorId, ownerId: ticket.ownerId, emojis: this.emojis }),
        flags: V2,
        allowedMentions: { parse: [] },
      });
      await logChannel.send({ files: [file] });
    }
    const name = channel.name;
    await channel.delete('Ticket deleted');
    log(`ticket ${name} deleted`);
  }

  /** Deletes closed tickets whose last message is older than DELETE_AFTER_HOURS. */
  async sweep(guild) {
    const closed = this.category(guild, 'closedTickets');
    if (!closed) return;
    const limit = Date.now() - DELETE_AFTER_HOURS * 60 * 60 * 1000;
    for (const channel of guild.channels.cache.filter((c) => c.parentId === closed.id).values()) {
      if (!parseTicketName(channel.name)) continue;
      const last = channel.lastMessageId ? SnowflakeUtil.timestampFrom(channel.lastMessageId) : channel.createdTimestamp;
      if (last > limit) continue;
      try {
        await this.deleteTicket(channel, channel.client.user.id);
      } catch (error) {
        log(`could not delete ${channel.name}: ${error.message}`);
      }
    }
  }
}
