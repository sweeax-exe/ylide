# Ylide Discord

Sets up the Ylide Discord server and runs its ticket bot.

- **Setup** (`npm run setup`) makes the server match [`src/spec.js`](src/spec.js)
  and [`src/content.js`](src/content.js): roles, categories, channels,
  permissions, forum tags, the styled info messages, Discord's onboarding,
  AutoMod rules and the bot's slash commands. It is idempotent: a second run
  changes nothing. `--dry-run` shows what would change first. It never deletes
  roles or channels it does not own.
- **Bot** (`npm start`, or the `ylide-discord` service on the server) runs the
  ticket system: a panel in `#tickets` with four buttons, a form for each, a
  private channel per ticket, claim, close, reopen, delete, transcripts and a
  log in `#ticket-log`. Feature ideas from the panel become public posts in the
  `#ideas` forum.

Built with [discord.js](https://discord.js.org) 14 (Apache-2.0), plain
JavaScript, no build step. Icons are [Lucide](https://lucide.dev) (ISC).

## Privacy

The bot keeps nothing about people outside Discord. On the server it stores one
number, the last ticket number (`state.json`). Who opened a ticket, who claimed
it and whether it is closed live in the ticket channel itself. Closed tickets
are deleted 48 hours after their last message; before that, an HTML transcript
is posted to the team-only `#ticket-log`. Log lines name tickets by channel
name only, without user names, IDs or message content.

The bot asks one outside address: `https://ylide.app/updates/latest.json`, to
suggest the current version in the bug report form.

## 1. Developer Portal

At <https://discord.com/developers/applications>, create the application
**Ylide**.

| Where | Setting |
|---|---|
| General Information | Copy the **Application ID** (public). App icon: `assets/server-icon.png`. |
| Installation | Installation contexts: **Guild Install** only. Install link: **None**. |
| Bot | **Public Bot: off**. Privileged intents: **Message Content Intent: on** (transcripts need it); Server Members and Presence stay off. **Reset Token** and keep it to yourself. |

Gateway intents the bot requests: `Guilds` only.

## 2. Server and invite

1. Create an empty server named Ylide ("Create my own").
2. Discord settings > Advanced > **Developer Mode** on; right-click the server > **Copy Server ID**.
3. Invite the bot with this link (fill in the Application ID and Server ID):

   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=8&integration_type=0&guild_id=SERVER_ID&disable_guild_select=true
   ```

   `permissions=8` is Administrator. The setup needs it: only an administrator
   may switch on Community, create the Maintainer role and set permission
   overwrites for every role. Bots cannot create servers any more (Discord
   removed that in July 2025), so the server must exist first.
4. In Server Settings > Roles, keep the bot's role **Ylide** at the top.

## 3. Settings

Locally, copy `.env.example` to `.env` (gitignored) and fill it in. On the
server the same keys go into `/etc/ylide-discord/env` (root, mode 600):

```
ssh ylide
nano /etc/ylide-discord/env
```

Never commit the token or paste it into a chat or an issue. If it leaks, reset
it in the Developer Portal.

## 4. Run the setup

```
npm ci
npm run setup -- --dry-run
npm run setup
```

Options: `--remove-default-channels` deletes Discord's starter categories
("Text Channels" and "Voice Channels", or "Textkanäle" and "Sprachkanäle")
once they are empty, and the starter voice channel (the starter text channel
becomes `#general`), `--refresh-emojis` uploads the emojis again after new art.

On the server instead: `node deploy/deploy.mjs --setup --dry-run` (the token
stays on the server).

### One step by hand

Discord has no API for rules screening. In **Server Settings > Safety Setup >
DM and spam protection**, turn on **"Members must accept rules before they can
talk or DM"** and paste these rules:

1. Be kind and constructive. Critique ideas, not people.
2. Keep channels on topic. Anything else goes to #off-topic.
3. Ask for help in #help, not in DMs. Private matters go to #tickets.
4. No spam, ads, invite links or unsolicited DMs.
5. Never post API keys, tokens, passwords or personal data.
6. Nothing illegal or NSFW, including pirated software and models.
7. English in the main channels; other languages in their own chats.
8. Follow Discord's Terms of Service and Community Guidelines.

## 5. Host the bot

The bot runs 24/7 as the systemd service `ylide-discord` on the Ylide server,
as the unprivileged user `ylide-discord`, with its state in
`/var/lib/ylide-discord` and the settings in `/etc/ylide-discord/env`.

```
node deploy/deploy.mjs --install   # once, as root: Node.js, user, folders, unit
node deploy/deploy.mjs             # upload a release as deploy@ylide and restart
node deploy/deploy.mjs --status    # service state and recent log lines
```

Run the bot either on the server or locally (`npm start`), never both at once:
two instances would answer every button twice.

## Development

| Task | Command |
|---|---|
| Tests | `npm test` |
| Re-render banner, icons and server icon | `npm run art` (Windows, Edge, needs the repo's `node_modules`) |
| Change channels, roles or texts | edit `src/spec.js` / `src/content.js`, then `npm run setup -- --dry-run` |

Layout: `src/setup` (setup), `src/bot` (ticket bot), `src/spec.js` (server
description), `src/content.js` (info messages), `art/` (artwork source),
`assets/` (rendered artwork, committed), `deploy/` (systemd unit, deploy script).
