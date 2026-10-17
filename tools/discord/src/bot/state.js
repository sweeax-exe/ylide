// The only things the bot stores outside Discord, in DATA_DIR/state.json:
//   lastTicket       the number of the last ticket, so numbers keep counting up
//   lastRelease      the last Ylide version announced in #releases (or recorded
//                    as known), so a restart never announces a version twice
//   releaseBaseline  set by `deploy.mjs --release-baseline <version>`: announce
//                    every version after this one on the next start
// No user names, IDs or messages. Everything else about a ticket lives in its
// channel.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class State {
  constructor(dir) {
    this.file = join(dir, 'state.json');
    mkdirSync(dir, { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data) + '\n');
    renameSync(tmp, this.file);
  }

  /** Reserves the next ticket number and saves it before returning. */
  nextTicket() {
    this.data.lastTicket = (Number(this.data.lastTicket) || 0) + 1;
    this.save();
    return this.data.lastTicket;
  }

  get lastRelease() {
    return this.data.lastRelease ?? null;
  }

  get releaseBaseline() {
    return this.data.releaseBaseline ?? null;
  }

  /** Records a version as announced (or known) and drops a used baseline. */
  setLastRelease(version) {
    this.data.lastRelease = version;
    delete this.data.releaseBaseline;
    this.save();
  }
}
