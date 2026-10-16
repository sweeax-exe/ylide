# Releasing Ylide

Ylide updates itself: at every start it asks `https://ylide.app/updates/latest.json`
whether a newer version exists. When the user clicks "Install", it downloads the
installer, checks its signature against the key built into the app, stops the model
and runs the installer in passive mode (`/P /R /UPDATE`), which closes Ylide and
starts it again. The check can be switched off under Settings → Network and privacy;
it sends nothing but the User-Agent `Ylide/<version>`.

The code is in `apps/desktop/src-tauri/src/updates.rs` (core) and
`apps/desktop/src/state/updates.ts` (notice and settings). The file format is the one
of Tauri's updater, and signatures are made with `tauri signer`, so the standard Tauri
tooling works. Ylide does not use `tauri-plugin-updater` itself: in October 2026 its
`zip ^4` dependency could not be resolved, because all `zip` releases before 9.0.3 had
been yanked. The update requests also go through Ylide's network gate this way, like
every other request.

## The signing key

* Private key: `~/.tauri/ylide-updater.key` (outside the repository, no password).
  **Back it up** (e.g. in a password manager). Without it, existing installations can
  never be updated again; a new key needs a new app version installed by hand.
* Public key: `RELEASE_PUBKEY` in `apps/desktop/src-tauri/src/signing.rs` (the
  base64 content of `ylide-updater.key.pub`). The same key signs the installers
  and the model list.
* Another location: set `TAURI_SIGNING_PRIVATE_KEY_PATH`; a password goes in
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Publishing a version

Prerequisites: the "Build from source" setup in README.md (`npm install`,
`node scripts/fetch-runtime.mjs`), the signing key, and a `Host ylide` entry in
`~/.ssh/config` (HostName 49.12.78.32, the key that the `deploy` user accepts).

1. Set the same version in `Cargo.toml` (`[workspace.package]`) and
   `apps/desktop/src-tauri/tauri.conf.json`. Updates are offered only to older
   versions (semver).
2. Build, sign and check:

   ```sh
   node scripts/release.mjs --notes "What changed, in one or two sentences"
   ```

   This builds the NSIS installer, signs it, verifies the signature against the key
   built into the app and writes `target/release/bundle/updates/` with the
   installer, its `.sig` and `latest.json`. Before building it adds missing license
   texts to the bundled runtimes and stops if `THIRD_PARTY_LICENSES.txt` does not
   match the dependencies; after dependency updates run `npm run licenses` and
   commit the result.
3. Try the installer, then publish:

   ```sh
   node scripts/release.mjs --publish-only
   ```

   It uploads to `deploy@ylide:/var/www/ylide/updates/` (the `ylide` host in
   `~/.ssh/config`). `latest.json` goes last and is renamed into place, so no client
   sees it before the installer is complete. `--publish` builds and uploads in one go.

   Both refuse to start unless the model list this version reads
   (`DEFAULT_REGISTRY_URL` in `settings.rs`) and its `.sig` are on the server. When
   that address or the list format changed, publish the model list first (see
   below).

Running Ylide 0.x installations pick the version up at their next start.

A published version is never changed: `--publish` refuses to upload an
installer whose content differs from the one already on the server under the
same version. Bump the version instead. (`--replace` overrides this, only for a
version nobody can have installed yet.)

## Publishing the source code

The public repository [github.com/sweeax-exe/ylide](https://github.com/sweeax-exe/ylide)
gets one commit per released version ("Ylide 0.1.5", tagged `v0.1.5`); the
development history stays in this checkout. Right after `release.mjs --publish`,
while `HEAD` is still the commit the release was built from:

```sh
node scripts/publish-source.mjs
```

builds the snapshot in `target/public-repo` with `git archive` (only committed
files, so nothing gitignored can slip in), checks it and shows what changes.
It refuses key files, private keys and tokens, paths of this machine and every
term listed in `~/.ylide-publish-deny` (one per line; that file stays out of the
repository because it names what must stay private). Then:

```sh
node scripts/publish-source.mjs --publish
```

commits "Ylide <version>", tags it, pushes both and creates the GitHub release,
which links to the installer on ylide.app. When the local build in
`target/release/bundle/updates/` is byte for byte the published one, the
installer, its `.sig` and its SHA-256 are attached as well.

The script only publishes the version ylide.app offers in `latest.json`, and
never a tag that already exists. `--commit <rev>` names the release commit when
`HEAD` has moved on; `--docs-from <rev>` takes README, `.github` and
`docs/images` from a later commit, for documents written after a release.
Pull requests on GitHub are applied here and ship with the next release.

## Publishing the model list

The model list (`registry/models.json`) names the models and the runtime
downloads with their checksums. Because the runtimes are programs, the official
list at `https://ylide.app/registry/v2/models.json` is signed with the same
release key, and Ylide accepts it only with a valid `models.json.sig` (signed
file name `models.json`). A list at an address the user set in the settings is checked when
it has a signature and accepted without one.

```sh
node scripts/publish-registry.mjs --publish
```

checks the list (the `registry` crate's tests), writes the schema 2 list and the
schema 1 list without the uncensored models for Ylide 0.1.3 and older (at the old
address `https://ylide.app/registry/models.json`, see `docs/registry.md`), signs
both, verifies the signatures against the app's key and uploads all four files. Apps pick up a newer
`registryVersion` at their next start; unchanged lists cost a 304.

## What the app checks

* `latest.json` must offer a version newer than the running one, without build
  metadata, and an HTTPS link to an `.exe`.
* The installer must carry a valid signature of the release key, and the file
  name in the signature's trusted comment (`tauri signer` writes
  `file:Ylide_<version>_x64-setup.exe`) must name exactly the offered version.
  So a changed `latest.json` cannot pass an older signed installer off as new.
* The file is verified again right before it is started.
* The installer itself refuses downgrades (`allowDowngrades: false`).

## The server

A Hetzner VPS (Ubuntu 26.04 LTS) at `49.12.78.32` / `2a01:4f8:c016:3300::1`, with DNS
`A`/`AAAA` records for `ylide.app` and `www.ylide.app`.

* SSH with keys only (`/etc/ssh/sshd_config.d/10-ylide.conf`); `root` for
  administration, `deploy` for uploads. Firewall (ufw): 22, 80, 443.
* Unattended security upgrades are on.
* Caddy (`/etc/caddy/Caddyfile`) serves `/var/www/ylide/site` as the homepage,
  `/var/www/ylide/updates` under `/updates/` and `/var/www/ylide/registry` (the
  model lists and their `.sig` files: `models.json` for old apps, `v2/models.json`)
  under `/registry/`. Unknown addresses get a real 404
  with the site's `404.html`. It fetches and renews the HTTPS certificates itself.
  There is no access log: Ylide promises no tracking, and that includes who checks
  for updates.
* `latest.json` and the model list are sent with `Cache-Control: no-cache` (so
  they are revalidated by ETag, and an unchanged list costs a 304), installers as
  immutable.
* The homepage is a symlink to the current upload under
  `/var/www/ylide/releases/`; `node website/build.mjs --publish` uploads a new
  one and swaps the link.
