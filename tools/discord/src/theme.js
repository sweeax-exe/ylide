// Ylide colours as Discord integers, taken from the app's design tokens
// (apps/desktop/src/design/tokens.ts, docs/design.md). Discord shows them as
// role colours and as the accent bar of message containers.

export const colors = {
  qubit: 0x22d3ee, // accent: focus, primary actions
  brass: 0xc9a66b, // hardware, "local"
  violet: 0xb6a6ff, // editor keyword colour
  success: 0x3dd68c,
  warning: 0xf2a93b,
  danger: 0xf47067,
  text2: 0x9aa6bb,
  text3: 0x808ca6,
};

// Application emojis the setup uploads from assets/emoji/<name>.png. They
// belong to the bot, so they work in every server without using emoji slots.
export const emojiNames = [
  'ylide_mark',
  'ylide_bug',
  'ylide_help',
  'ylide_idea',
  'ylide_other',
  'ylide_claim',
  'ylide_close',
  'ylide_reopen',
  'ylide_delete',
  'ylide_transcript',
];

export const links = {
  website: 'https://ylide.app',
  privacy: 'https://ylide.app/privacy/',
  // The welcome and contributing messages show a "Source code" button for it;
  // null hides the button.
  github: 'https://github.com/sweeax-exe/ylide',
  latest: 'https://ylide.app/updates/latest.json',
  discordTerms: 'https://discord.com/terms',
  discordGuidelines: 'https://discord.com/guidelines',
};
