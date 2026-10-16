// Slash commands for the team, registered by the setup as guild commands.
// default_member_permissions hides them from everyone without ManageThreads
// (Support, Moderator, Maintainer); the bot checks the role again anyway.

import { P } from '../permissions.js';

export const commands = [
  {
    name: 'ticket',
    description: 'Manage the ticket in this channel',
    type: 1,
    default_member_permissions: P.ManageThreads.toString(),
    options: [
      {
        type: 1,
        name: 'add',
        description: 'Give someone access to this ticket',
        options: [{ type: 6, name: 'user', description: 'Who to add', required: true }],
      },
      {
        type: 1,
        name: 'remove',
        description: "Take away someone's access to this ticket",
        options: [{ type: 6, name: 'user', description: 'Who to remove', required: true }],
      },
      { type: 1, name: 'close', description: 'Close this ticket' },
    ],
  },
];
