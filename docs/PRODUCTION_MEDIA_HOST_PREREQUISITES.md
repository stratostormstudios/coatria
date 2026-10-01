# Production media host prerequisites

This is an operator procedure for a fresh Ubuntu 24.04 x64 VM using the reviewed
`4f55b6d` source contract. It prepares the prerequisites of the archive, reference
or image-preparation installer. It neither qualifies the VM nor enrolls or starts
a worker. Review the exact source, release digest and commands before execution.
No new bootstrap service is required, and **do not set `CI=true` on the target**.

## Separate the builder from the target

On a genuine isolated CI builder, the existing media preparation may produce the
pinned decoder/helper closure and its setup evidence. The
[offline exporter](../scripts/hosting/export-archive-host-runtime.mjs) verifies
those inputs, extracts Node/npm from the exact cached image, installs locked
dependencies offline and returns `qualified:false`. The exact-source host builder
then produces a complete release directory and `bundle.json` digest. These bytes
can be transferred to production; the builder's qualification cannot.

Transfer the **entire host bundle**, including its empty read-only `proc`/`dev`
mount points and declared modes, through trusted staging. Record its manifest
digest independently and use the existing installer's `plan` to verify every
member. The media CI evidence ZIP contains reports/manifests, not that complete
installable release. Reference/image preparation additionally need their separate
registrar artifacts; image preparation also needs its separate controller artifact.
Keep their matching source/tree/lock/runtime identities for the later operator steps.
Prepare the VM before creating the reference/image install scope: that scope has
an absolute expiry at most one hour away, and preparation does not extend it.

The target does not need Docker, npm, GCC, a checkout under `.devdata`, a CI
qualification JSON or the builder's hand-created cgroup. The installer derives
new profiles for the target release paths. Target systemd qualification must run
again against that target's kernel, policy, UID/GID and delegated cgroups.

## Check the VM and install only prerequisites

Use a reviewed root shell with no application/provider credentials. `SOURCE` is a
canonical root-owned copy of the exact reviewed source, or an independently
verified exact-Git installer kit preserving `scripts/hosting/` and including the
pure `prepare-media-apparmor-ci.mjs` validators. `NODE` is a separately trusted
operator Node executable; `STAGED_BUNDLE` is the complete reviewed release directory.
Do not use a mutable user-writable checkout as either input. The installed
runtime's own pinned Node is used after installation.

```sh
set -eu
umask 022
test "$(id -u)" = 0
test "$(id -g)" = 0
test "$(uname -m)" = x86_64
test "$(cat /proc/1/comm)" = systemd
systemctl --version
test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
cat /sys/fs/cgroup/cgroup.controllers
```

Require systemd >=254 and `cpu`, `memory`, `pids` controllers. The exact installer
and native canary make the remaining platform checks. A Docker Pod or a successful
`systemctl --version` alone does not establish these facilities.

```sh
apt-get update
apt-get install -y --no-install-recommends \
  acl apparmor procps util-linux bubblewrap=0.9.0-1ubuntu0.3
test "$(dpkg-query -W -f='${Version}' bubblewrap)" = 0.9.0-1ubuntu0.3
test -f /etc/apparmor.d/abi/4.0
test "$(cat /sys/module/apparmor/parameters/enabled)" = Y
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
dpkg-query -W acl apparmor procps util-linux bubblewrap
```

These pins come from [the package contract](../scripts/hosting/archive-host-package.mjs).
The installer also compares the actual `/usr/bin/bwrap` hash with the release
manifest; package version alone is insufficient. If the exact package or ABI is
unavailable, stop for a reviewed pin/platform decision. Do not substitute a newer
package, disable AppArmor, change global user-namespace settings or add an exception.

Each service unit has a 2 GiB memory cap, zero swap, 256 tasks and 200% CPU bandwidth;
these are ceilings, not a minimum VM specification or a throughput guarantee.
Leave memory for the OS and any other active units. Before installation, measure
the staged release with `du -sx --block-size=1 "$STAGED_BUNDLE"` and available
space with `df -B1 /var/lib`. Allow for both staging and installed copies, retained
evidence and bounded work files. Preparation's 32 MiB source and 10 MiB output
limits are not a total scratch-disk reservation. The source defines no universal
minimum disk size; select capacity for the approved workload and check it on target.

## Activate the exact AppArmor profile on a clean host

Retain this preparation directory and its evidence. It is not a qualification
receipt. Download the exact package through the VM's normal signed Ubuntu APT
indexes; extract only the approved member, without installing the other profiles.

```sh
REVIEW=$(mktemp -d /var/lib/coatria-host-prerequisites.XXXXXXXX)
cd "$REVIEW"
apt-get download apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.8
DEB=apparmor-profiles_4.0.1really4.0.1-0ubuntu0.24.04.8_all.deb
test "$(wc -c < "$DEB")" -eq 39618
printf '%s  %s\n' \
  4e7d728322f899a7a06e71bedd4f4bd1f20c21f0b3361120f34cf5c0feec849e "$DEB" \
  | sha256sum --check --status
dpkg-deb --fsys-tarfile "$DEB" > profile-package.tar
tar -xOf profile-package.tar ./usr/share/apparmor/extra-profiles/bwrap-userns-restrict \
  > reviewed-profile
```

Use the existing **pure validators**, not `prepareMediaAppArmorCI()`. The following
preflight refuses existing target declarations or loaded profiles, including an
apparently matching one: disk bytes do not authenticate an already loaded kernel
policy. It also rejects policy/local/disable overrides, unsafe paths and ACLs.
An existing or partially prepared host needs separate review; do not delete or
replace its policy to pass this fresh-host procedure.

```sh
"$NODE" --input-type=module - "$SOURCE" "$REVIEW" <<'NODE'
import {readFile,readdir,lstat,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [source,review]=process.argv.slice(2);
const {archiveHostTrusted}=await import(pathToFileURL(join(source,'scripts/hosting/archive-host-package.mjs')));
const {assertReviewedProfile,hasBwrapDeclaration,relevantLoadedProfiles}=await import(pathToFileURL(join(source,'scripts/hosting/prepare-media-apparmor-ci.mjs')));
for(const path of [source,review,'/etc/apparmor.d','/etc/apparmor.d/local'])await archiveHostTrusted(path,true);
for(const path of ['/usr/bin/bwrap','/usr/sbin/apparmor_parser',join(review,'reviewed-profile')])await archiveHostTrusted(path);
assertReviewedProfile(await readFile(join(review,'reviewed-profile')));
if(relevantLoadedProfiles(await readFile('/sys/kernel/security/apparmor/profiles','utf8')).length)throw Error('Existing loaded target policy');
let total=0;
for(const name of await readdir('/etc/apparmor.d')){
  const path=join('/etc/apparmor.d',name),entry=await lstat(path),info=entry.isSymbolicLink()?await stat(path):entry;
  if(!info.isFile())continue;
  if(entry.isSymbolicLink())throw Error('Policy file symlink needs review');
  await archiveHostTrusted(path);total+=info.size;
  if(info.size>1048576||total>8388608)throw Error('Policy review bound');
  if(hasBwrapDeclaration(await readFile(path,'utf8')))throw Error('Existing target declaration');
}
for(const name of ['bwrap-userns-restrict','unpriv_bwrap']){
  const path=join('/etc/apparmor.d/local',name);
  try{await archiveHostTrusted(path);if((await readFile(path,'utf8')).split('\n').some(line=>line.replace(/#.*/,'').trim()))throw Error('Local policy override');}catch(error){if(error.code!=='ENOENT')throw error;}
}
for(const directory of ['disable','force-complain'])for(const name of ['bwrap','bwrap-userns-restrict','coatria-bwrap-userns-restrict']){
  try{await lstat(join('/etc/apparmor.d',directory,name));throw Error('Policy mode override');}catch(error){if(error.code!=='ENOENT')throw error;}
}
NODE
```

Record global settings immediately before activation and compare afterward:

```sh
record_apparmor_globals() {
  for p in /sys/module/apparmor/parameters/enabled \
    /proc/sys/kernel/apparmor_restrict_unprivileged_userns \
    /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined \
    /proc/sys/kernel/unprivileged_userns_clone; do
    printf '%s=' "$p"
    if test -f "$p"; then cat "$p"; else printf 'absent\n'; fi
  done
}
record_apparmor_globals > "$REVIEW/global-before.txt"
"$NODE" --input-type=module - "$SOURCE" "$REVIEW" <<'NODE'
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [source,review]=process.argv.slice(2);
const {assertReviewedProfile}=await import(pathToFileURL(join(source,'scripts/hosting/prepare-media-apparmor-ci.mjs')));
const bytes=assertReviewedProfile(await readFile(join(review,'reviewed-profile')));
await writeFile('/etc/apparmor.d/coatria-bwrap-userns-restrict',bytes,{flag:'wx',mode:0o644});
NODE
apparmor_parser --add --skip-read-cache /etc/apparmor.d/coatria-bwrap-userns-restrict
record_apparmor_globals > "$REVIEW/global-after.txt"
cmp "$REVIEW/global-before.txt" "$REVIEW/global-after.txt"
"$NODE" --input-type=module - "$SOURCE" <<'NODE'
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {assertReviewedProfile,relevantLoadedProfiles}=await import(pathToFileURL(join(process.argv[2],'scripts/hosting/prepare-media-apparmor-ci.mjs')));
assertReviewedProfile(await readFile('/etc/apparmor.d/coatria-bwrap-userns-restrict'));
const loaded=relevantLoadedProfiles(await readFile('/sys/kernel/security/apparmor/profiles','utf8'));
if(!loaded.some(p=>p.profile==='bwrap')||!loaded.some(p=>p.profile==='unpriv_bwrap')||loaded.some(p=>p.mode!=='enforce'))throw Error('Target profiles must all enforce');
NODE
test "$(cat /sys/module/apparmor/parameters/enabled)" = Y
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
```

The exclusive write never overwrites a policy; `--add` never requests replacement.
Stop on any failure and retain the partial state. The actual installed canary
must still prove the enforcing child attachment and containment.

## Prepare one dedicated identity, then hand off to the installer

Choose exactly the identity required by the selected installer: `coatria-archive`,
`coatria-reference` or `coatria-image-preparation`. This example creates only an
absent image-preparation identity and otherwise checks the existing identity:

```sh
SERVICE=coatria-image-preparation
if getent passwd "$SERVICE"; then
  printf 'Existing identity: verify without modifying it.\n'
else
  test "$?" -eq 2
  if getent group "$SERVICE"; then
    printf 'Existing orphan group needs review.\n' >&2; exit 1
  else
    test "$?" -eq 2
  fi
  useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$SERVICE"
fi
uid=$(id -u "$SERVICE"); gid=$(id -g "$SERVICE")
test "$uid" -gt 0; test "$gid" -gt 0
test "$(id -G "$SERVICE")" = "$gid"
test "$(getent group "$gid" | cut -d: -f1)" = "$SERVICE"
test "$(getent passwd "$SERVICE" | cut -d: -f7)" = /usr/sbin/nologin
if pgrep -u "$uid"; then
  printf 'Service UID is already active.\n' >&2; exit 1
else
  test "$?" -eq 1
fi
```

The expected lookup miss is status2; a process-free UID is `pgrep` status1 with
empty output. Any other failure needs review. Existing users must have no extra
groups and the dedicated non-login shell; never automatically remove groups,
kill processes or reuse a login account. The reference/image installers repeat
the identity, group and inactive-process checks before writing their units.

Use the selected installer's reviewed `plan`, then explicit `install`. The
installer checks root-owned canonical paths and ACLs, exact package/policy bytes,
and existing configuration/units; reference and image installers also reject
unit aliases, drop-ins, enabled links and shared-identity conflicts. Preserve any
partial installation. Do not precreate/chown the host cgroup or imitate the CI
root cgroup preparation: static systemd units and the installed delegation code
create and validate their own capped service subtrees.

Follow [archive](ARCHIVE_HOST_DEPLOYMENT.md),
[reference](HIGGSFIELD_REFERENCE_DEPLOYMENT.md), or
[image preparation](HIGGSFIELD_IMAGE_PREPARATION.md#operator-registrar-transactions)
for independent target qualification, reviewed root acceptance and later authority.
Archive's documented post-acceptance qualifier stop is specific to archive.
For reference/image preparation, retain the successful qualifier `active/exited`
through enrollment and the finite worker lifetime. Image preparation's qualifier
also holds ordering references to its exact preflight/worker units, preserving
their completed invocation evidence. Do not copy archive's stop-after-acceptance
step, restart qualification under an existing enrollment, or delete receipts and
permanent attempt fences. Explicit worker stop and verified drain come first.
Reboot, expiry or changed code requires the respective reviewed lifecycle.

This runbook adds no deployment evidence. Package/profile preparation, successful
target qualification, database/service enrollment, live storage/provider access
and client delivery remain distinct results.
