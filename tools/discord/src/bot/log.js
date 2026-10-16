// Log lines go to stdout (journald on the server). They name tickets by
// channel name only: no user names, IDs or message content.

export function log(message) {
  console.log(message);
}
