// Discord permission bits (https://docs.discord.com/developers/topics/permissions).
// Kept here instead of using discord.js's table so new flags such as
// PinMessages (split from ManageMessages in 2025) are spelled out explicitly.

export const P = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTTSMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  ModerateMembers: 1n << 40n,
  CreateEvents: 1n << 44n,
  SendVoiceMessages: 1n << 46n,
  SendPolls: 1n << 49n,
  UseExternalApps: 1n << 50n,
  PinMessages: 1n << 51n,
  BypassSlowmode: 1n << 52n,
};

/** ORs permission names (keys of P) into one bit field. */
export function bits(...names) {
  let value = 0n;
  for (const name of names) {
    if (!(name in P)) throw new Error(`unknown permission ${name}`);
    value |= P[name];
  }
  return value;
}

/** Names of the bits set in `value`, for readable dry-run output. */
export function names(value) {
  const v = BigInt(value);
  return Object.entries(P)
    .filter(([, bit]) => (v & bit) === bit)
    .map(([name]) => name);
}

// What every member may do server-wide once they have accepted the rules.
// Mentioning @everyone, private threads and external apps stay with the team.
export const everyoneBase = bits(
  'ViewChannel',
  'CreateInstantInvite',
  'ChangeNickname',
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'EmbedLinks',
  'AttachFiles',
  'AddReactions',
  'UseExternalEmojis',
  'UseExternalStickers',
  'ReadMessageHistory',
  'UseApplicationCommands',
  'SendPolls',
  'Connect',
  'Speak',
  'Stream',
  'UseVAD',
  'RequestToSpeak',
  'SendVoiceMessages',
);

/** Everything that lets someone write somewhere; denied in read-only channels. */
export const writing = bits(
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'SendPolls',
);

/** What a member can do in their own ticket channel. */
export const ticketMember = bits(
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AttachFiles',
  'EmbedLinks',
  'AddReactions',
  'UseExternalEmojis',
);

/** What the bot gives itself in private channels, so it can always see them. */
export const botChannel = bits(
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AttachFiles',
  'EmbedLinks',
  'ManageChannels',
  'ManageRoles',
  'ManageMessages',
  'PinMessages',
  'ManageThreads',
);
