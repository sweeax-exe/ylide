// The Ylide Discord bot: runs the ticket system. Start it with
//   npm start            (locally, reads .env)
// or as the systemd service ylide-discord on the server (deploy/).
//
// It only needs the Guilds gateway intent. Reading a ticket's messages for the
// transcript needs the Message Content intent switched on in the Developer
// Portal; it is not requested over the gateway.

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { loadEnv } from '../env.js';
import { State } from './state.js';
import { Tickets } from './tickets.js';
import { startVersionWatch } from './version.js';
import { ReleaseAnnouncer } from './releases.js';
import { log } from './log.js';

const SWEEP_EVERY = 30 * 60 * 1000;

const env = loadEnv();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let tickets;

/** Reads one field of a submitted modal: text, selected values or files. */
function modalReader(interaction) {
  const field = (id) => {
    try {
      return interaction.fields.getField(id);
    } catch {
      return null;
    }
  };
  return {
    read: (id) => {
      const f = field(id);
      return f?.values ?? f?.value ?? null;
    },
    files: (() => {
      const f = field('files');
      return f?.attachments ? [...f.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size })) : [];
    })(),
  };
}

async function route(interaction) {
  if (interaction.guildId !== env.guildId) return;
  if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') return tickets.command(interaction);
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id.startsWith('ticket:open:')) return tickets.openForm(interaction, id.slice('ticket:open:'.length));
    if (id === 'ticket:claim') return tickets.claim(interaction);
    if (id === 'ticket:close') return tickets.askClose(interaction);
    if (id === 'ticket:close-confirm') return tickets.close(interaction);
    if (id === 'ticket:reopen') return tickets.reopen(interaction);
    if (id === 'ticket:delete') return tickets.remove(interaction);
    if (id === 'ticket:transcript') return tickets.sendTranscript(interaction);
    return;
  }
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (id === 'idea:form') return tickets.submitIdea(interaction, modalReader(interaction));
    if (id.startsWith('ticket:form:')) return tickets.submitForm(interaction, id.slice('ticket:form:'.length), modalReader(interaction));
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await route(interaction);
  } catch (error) {
    log(`interaction failed: ${error.message}`);
    const reply = { content: 'Something went wrong. Please try again in a minute, or tell the team in #help.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
      else if (interaction.isRepliable()) await interaction.reply(reply);
    } catch {
      // The interaction may have expired; nothing more to do.
    }
  }
});

client.once(Events.ClientReady, async () => {
  const emojis = Object.fromEntries((await client.application.emojis.fetch()).map((e) => [e.name, e.id]));
  const state = new State(env.dataDir);
  tickets = new Tickets({ state, emojis });
  const guild = await client.guilds.fetch(env.guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();
  const releases = new ReleaseAnnouncer({ state, guild, emojis });
  startVersionWatch((release) => releases.check(release));
  const sweep = () => tickets.sweep(guild).catch((error) => log(`sweep failed: ${error.message}`));
  sweep();
  setInterval(sweep, SWEEP_EVERY);
  log(`ready as ${client.user.username} in ${guild.name}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    client.destroy().finally(() => process.exit(0));
  });
}

client.login(env.token);
