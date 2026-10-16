// The only thing the bot stores outside Discord: the number of the last
// ticket, so ticket numbers keep counting up across restarts. Everything else
// (who opened a ticket, who claimed it, whether it is closed) lives in the
// ticket channel itself.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class Counter {
  constructor(dir) {
    this.file = join(dir, 'state.json');
    mkdirSync(dir, { recursive: true });
    try {
      this.last = Number(JSON.parse(readFileSync(this.file, 'utf8')).lastTicket) || 0;
    } catch {
      this.last = 0;
    }
  }

  /** Reserves the next ticket number and saves it before returning. */
  next() {
    this.last += 1;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastTicket: this.last }) + '\n');
    renameSync(tmp, this.file);
    return this.last;
  }
}
