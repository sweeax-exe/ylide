// Puts the Ylide Discord bot on the server (Hetzner, Ubuntu 26.04).
//
//   node deploy/deploy.mjs --install   once, as root (ssh alias "ylide"): Node.js,
//                                      service user, folders, systemd unit, an
//                                      empty /etc/ylide-discord/env for the token
//   node deploy/deploy.mjs [--no-restart]
//                                      upload a new release as deploy@ylide,
//                                      switch to it and restart the service
//   node deploy/deploy.mjs --restart   as root: restart the service (also after
//                                      it gave up, e.g. before the token was set)
//   node deploy/deploy.mjs --setup [--dry-run]
//                                      run the server setup on the server, with
//                                      the token from /etc/ylide-discord/env
//   node deploy/deploy.mjs --status    service state and the last log lines
//
// Releases go to /opt/ylide-discord/releases/<stamp>; "current" links to the
// active one, and the last three are kept. node_modules is uploaded as well
// (discord.js is plain JavaScript), so the server needs no npm.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Without the trailing separator: on Windows `"D:\…\discord\"` would escape the quote.
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const args = new Set(process.argv.slice(2));
const ROOT_HOST = 'ylide';
const DEPLOY_HOST = 'deploy@ylide';
const BASE = '/opt/ylide-discord';
const SERVICE = 'ylide-discord.service';

const ssh = (host, script, input) => execFileSync('ssh', [host, script], { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input });

// The public IDs from the local .env, so only the token is left to fill in on
// the server. Only all-digit values match; the token is never read out.
function localId(key) {
  const file = new URL('../.env', import.meta.url);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return new RegExp(`^${key}=(\\d{17,20})\\s*$`, 'm').exec(text)?.[1] ?? '';
}

if (args.has('--install')) {
  const unit = readFileSync(new URL('./ylide-discord.service', import.meta.url), 'utf8');
  const script = `set -eu
export DEBIAN_FRONTEND=noninteractive
command -v node >/dev/null || { apt-get update -q; apt-get install -y -q --no-install-recommends nodejs; }
node --version
id ylide-discord >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ylide-discord
install -d -o deploy -g deploy -m 755 ${BASE} ${BASE}/releases
install -d -o root -g root -m 700 /etc/ylide-discord
if [ ! -f /etc/ylide-discord/env ]; then
  install -o root -g root -m 600 /dev/null /etc/ylide-discord/env
  printf '%s\\n' '# Settings of the Ylide Discord bot. Keep this file at mode 600.' 'DISCORD_TOKEN=' 'DISCORD_APP_ID=${localId('DISCORD_APP_ID')}' 'DISCORD_GUILD_ID=${localId('DISCORD_GUILD_ID')}' > /etc/ylide-discord/env
fi
cat > /etc/systemd/system/${SERVICE} <<'UNIT'
${unit}UNIT
cat > /etc/sudoers.d/ylide-discord <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${SERVICE}, /usr/bin/systemctl is-active ${SERVICE}
SUDO
chmod 440 /etc/sudoers.d/ylide-discord
visudo -cf /etc/sudoers.d/ylide-discord
systemctl daemon-reload
systemctl enable ${SERVICE}
echo "Installed. Next: put the token into /etc/ylide-discord/env, then deploy."`;
  ssh(ROOT_HOST, 'sh -s', script);
} else if (args.has('--setup')) {
  // Runs as the service user with the service's settings; the token never leaves the server.
  const extra = [...args].filter((a) => a !== '--setup').join(' ');
  ssh(
    ROOT_HOST,
    `systemd-run --quiet --wait --pipe --collect -p User=ylide-discord -p EnvironmentFile=/etc/ylide-discord/env -p WorkingDirectory=${BASE}/current /usr/bin/node src/setup/run.js ${extra}`,
  );
} else if (args.has('--restart')) {
  ssh(
    ROOT_HOST,
    `systemctl reset-failed ${SERVICE} 2>/dev/null; systemctl restart ${SERVICE}; sleep 6; systemctl --no-pager status ${SERVICE} | head -n 5; journalctl --no-pager -u ${SERVICE} -n 15 -o short-iso`,
  );
} else if (args.has('--status')) {
  ssh(ROOT_HOST, `systemctl --no-pager status ${SERVICE} | head -n 5; journalctl --no-pager -u ${SERVICE} -n 30 -o short-iso`);
} else {
  if (!existsSync(new URL('../node_modules/discord.js/package.json', import.meta.url))) {
    throw new Error('node_modules is missing: run "npm ci" in tools/discord first');
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const release = `${BASE}/releases/${stamp}`;
  const restart = !args.has('--no-restart');
  const script = [
    'set -e',
    `mkdir -p ${release}`,
    `tar -C ${release} -xf -`,
    `ln -sfn releases/${stamp} ${BASE}/current.next`,
    `mv -T ${BASE}/current.next ${BASE}/current`,
    `ls -1dt ${BASE}/releases/*/ | tail -n +4 | xargs -r rm -rf`,
    // Without a token in /etc/ylide-discord/env the bot exits; systemd gives up after a few tries.
    ...(restart
      ? [`sudo systemctl restart ${SERVICE}`, 'sleep 4', `sudo systemctl is-active ${SERVICE} || echo "not running: check the token, then node deploy/deploy.mjs --status"`]
      : []),
    `echo released ${stamp}`,
  ].join('; ');
  const files = ['package.json', 'package-lock.json', 'src', 'assets', 'node_modules'].join(' ');
  execSync(`tar -C "${root}" -cf - ${files} | ssh ${DEPLOY_HOST} "${script}"`, { stdio: 'inherit' });
}
