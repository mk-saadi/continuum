"""Reproduce the selected helper in an unprivileged, persistent local build root.

No host package installation, pin updates, release entitlement or source-archive
approval. The original review tarball also contains nondeterministic build logs
and tar metadata; matching the helper alone cannot recreate/approve that archive.
Run with --archive-mirror only if the documented dated snapshot is unavailable;
the exact critical distro versions and final helper digest remain mandatory.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive-mirror', action='store_true')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
base = repo / '.continuum-local/recovery'
inputs = base / 'inputs'
inputs.mkdir(parents=True, exist_ok=True)
provenance = json.loads((repo / 'docs/b2-g4-helper-candidate.json').read_text())
for name, entry in provenance['inputs'].items():
    target = inputs / name
    if not target.exists():
        subprocess.run(['curl', '--fail', '--location', '--retry', '2', '--max-time', '180',
                        '--output', str(target), entry['url']], check=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    print(name, digest, flush=True)
    if digest != entry['sha256']:
        raise SystemExit('Input pin mismatch: ' + name + '; preserve and investigate the bytes.')
root = base / 'rootfs'
root.mkdir(exist_ok=True)
if (root / 'build/materials').exists():
    raise SystemExit('Existing build material retained. Move the build directory aside before a clean reproduction.')
if not (root / 'bin/sh').exists():
    # Official fixed-hash Ubuntu base; root filesystem symlinks are intentional.
    with tarfile.open(inputs / 'ubuntu-base.tar.gz') as archive:
        archive.extractall(root, filter='fully_trusted')
(root / 'build').mkdir(exist_ok=True)
(root / 'etc/ssl/certs').mkdir(parents=True, exist_ok=True)
shutil.copyfile('/etc/ssl/certs/ca-certificates.crt', root / 'etc/ssl/certs/ca-certificates.crt')
for name in ['slirp4netns-source.tar.gz', 'libslirp-source.tar.gz']:
    shutil.copyfile(inputs / name, root / 'build' / name)
shutil.copyfile(repo / 'scripts/rebuild-workspace-network-helper.sh', root / 'build/rebuild.sh')
mirror = 'https://archive.ubuntu.com/ubuntu/' if args.archive_mirror else provenance['build']['aptSnapshot']
(root / 'etc/apt/sources.list').write_text('\n'.join(
    'deb [check-valid-until=no] ' + mirror + ' ' + suite + ' main universe'
    for suite in provenance['build']['suites']) + '\n')
pinned = ['libc6-dev=2.35-0ubuntu3.15', 'libglib2.0-dev=2.72.4-0ubuntu2.10',
          'libseccomp-dev=2.5.3-2ubuntu3~22.04.1', 'libcap-dev=1:2.44-1ubuntu0.22.04.3',
          'gcc-11=11.4.0-1ubuntu1~22.04.3']
command = 'apt-get -o APT::Sandbox::User=root -o APT::Update::Error-Mode=any update && ' + \
    'DEBIAN_FRONTEND=noninteractive apt-get -o APT::Sandbox::User=root install --no-install-recommends -y ' + \
    ' '.join(provenance['build']['packages'] + pinned) + ' && sh /build/rebuild.sh'
subprocess.run(['/usr/bin/bwrap', '--die-with-parent', '--unshare-user', '--uid', '0', '--gid', '0',
                '--unshare-pid', '--bind', str(root), '/', '--proc', '/proc', '--dev', '/dev',
                '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
                '--tmpfs', '/tmp', '--chdir', '/', '/bin/sh', '-c', command], check=True)
helper = root / 'build/materials/slirp4netns'
digest = hashlib.sha256(helper.read_bytes()).hexdigest()
print('REBUILT HELPER', digest, 'EXPECTED', provenance['artifact']['sha256'], flush=True)
if digest != provenance['artifact']['sha256']:
    raise SystemExit('Rebuilt helper mismatch; pins unchanged. Inspect the preserved link map/inputs.')
print('Helper matches. Exact independently pinned review archive is STILL required for local activation.')
