// Reads the settings from the environment. Locally they come from a gitignored
// .env file (node --env-file=.env), on the server from /etc/ylide-discord/env.
// The token is never printed.

import { fileURLToPath } from 'node:url';

const descriptions = {
  DISCORD_TOKEN: 'the bot token from the Developer Portal (Bot > Reset Token)',
  DISCORD_APP_ID: 'the Application ID (General Information)',
  DISCORD_GUILD_ID: 'the server ID (right-click the server > Copy Server ID)',
};

export function loadEnv() {
  const missing = Object.keys(descriptions).filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    const lines = missing.map((key) => `  ${key}: ${descriptions[key]}`).join('\n');
    throw new Error(`Missing settings. Put them into tools/discord/.env (see .env.example):\n${lines}`);
  }
  for (const key of ['DISCORD_APP_ID', 'DISCORD_GUILD_ID']) {
    if (!/^\d{17,20}$/.test(process.env[key].trim())) throw new Error(`${key} must be a numeric Discord ID`);
  }
  return {
    token: process.env.DISCORD_TOKEN.trim(),
    appId: process.env.DISCORD_APP_ID.trim(),
    guildId: process.env.DISCORD_GUILD_ID.trim(),
    dataDir: process.env.DATA_DIR?.trim() || fileURLToPath(new URL('../data/', import.meta.url)),
  };
}
