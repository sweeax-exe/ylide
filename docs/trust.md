# Trust and verifying downloads

Ylide's code is public, but what reaches your computer is not decided by whoever
can open a pull request. This page explains what protects installed copies and
how to check a download yourself.

## The release key

Installers and the official model list are signed with one release key (a
[minisign](https://jedisct1.github.io/minisign/) key made with `tauri signer`).

* The private half stays with the maintainer, outside this repository and
  outside any CI system.
* The public half is built into the app (`RELEASE_PUBKEY` in
  `apps/desktop/src-tauri/src/signing.rs`):

  ```text
  untrusted comment: minisign public key: C199B26B1CF48553
  RWRThfQca7KZwRhSfPJch5m8OSGAGl+VFF3U8ge9HTV0MwfpY3m1pggv
  ```

So nobody can push an update to installed copies through this repository, not
a fork, a pull request or someone who gets into the GitHub account: Ylide
installs an update only when its signature matches this key and names exactly
the offered version (see "What the app checks" in [releasing.md](releasing.md)).
Code reaches users only when the maintainer reviews it, builds a release and
signs it. A fork that builds its own Ylide needs its own key, and its builds
cannot update yours.

## The model list

The model list names every model and runtime Ylide can download, with their
SHA-256 checksums. Because runtimes are programs, the official list at
`https://ylide.app/registry/v2/models.json` is signed with the same release key,
and Ylide refuses it without a valid `models.json.sig`. Every file downloaded
from Hugging Face or the llama.cpp releases is checked against the checksum in
that list before it is used.

`registry/models.json` in this repository is the source of that list and the
copy built into the app. Changing it in a pull request does not change what
installed apps download: that happens only when a maintainer signs and
publishes a new list (`scripts/publish-registry.mjs`).

If you point Ylide at a model list of your own (Settings → Network and
privacy), it is checked when it comes with a signature and accepted without
one. That is your choice; the official list is always signed.

## Verifying a download

The download button on [ylide.app](https://ylide.app) links to
`https://ylide.app/updates/Ylide_<version>_x64-setup.exe`. The signature is at
the same address with `.sig` appended. To check an installer before running
it:

1. Download the installer and its `.sig` into the same folder.
2. Get [minisign](https://github.com/jedisct1/minisign/releases) (any version
   from 0.10 on).
3. The `.sig` file holds the minisign signature in base64 (the format of
   `tauri signer`). Decode it and verify, in PowerShell:

   ```powershell
   $file = 'Ylide_0.1.4_x64-setup.exe'
   ```

   ```powershell
   [IO.File]::WriteAllBytes("$PWD\$file.minisig", [Convert]::FromBase64String((Get-Content "$file.sig" -Raw).Trim()))
   ```

   ```powershell
   minisign -V -P RWRThfQca7KZwRhSfPJch5m8OSGAGl+VFF3U8ge9HTV0MwfpY3m1pggv -m $file -x "$file.minisig"
   ```

4. minisign must print `Signature and comment signature verified`, and the
   trusted comment below it must end with the name of the file you
   downloaded, for example `file:Ylide_0.1.4_x64-setup.exe`.

The installers are not signed with a Windows code-signing certificate yet, so
Windows SmartScreen may warn about an unknown publisher. The minisign check
above is what tells you the file is the one the maintainer released.

## Reporting a problem

If you find a way around any of these checks, please report it privately as
described in [SECURITY.md](../SECURITY.md).
