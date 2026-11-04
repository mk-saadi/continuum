"""Collect a candidate's actual linker inputs, distro attribution and notices.

Run in the disposable build root, after rebuild-workspace-network-helper.sh.
Produces review materials, not a legal approval or a production activation.
"""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess


def collect(build=pathlib.Path('/build')):
    materials = build / 'materials'
    text = (materials / 'slirp4netns.map').read_text()
    inputs = sorted(set(re.findall(r'^LOAD (.+)$', text, re.M)))
    if not inputs or 'slirp4netns-main.o' not in inputs:
        raise ValueError('Expected the final helper link map, not a configure probe')
    rows = []
    sources = set()
    notices = materials / 'notices'
    notices.mkdir()
    link_root = materials / 'link-inputs'
    for name in inputs:
        original = pathlib.Path(name)
        file = (original if original.is_absolute() else build / 'slirp4netns' / original).resolve(strict=True)
        target = link_root / str(file).lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        row = {'linkName': name, 'resolved': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
        if str(file).startswith('/usr/') and not str(file).startswith('/usr/local/'):
            owner = subprocess.check_output(['dpkg-query', '-S', str(file)], text=True).split(': /')[0]
            fields = subprocess.check_output(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}', owner], text=True).split('\t')
            row['package'], row['version'], row['sourcePackage'], row['sourceVersion'] = fields
            sources.add((fields[2], fields[3]))
            copyright_file = pathlib.Path('/usr/share/doc') / fields[0].split(':')[0] / 'copyright'
            shutil.copyfile(copyright_file, notices / (fields[0].replace(':', '_') + '.copyright'))
        elif str(file).startswith('/usr/local/'):
            row['source'] = 'libslirp-source.tar.gz (pinned upstream archive)'
        else:
            row['source'] = 'slirp4netns-source.tar.gz (includes vendor/parson)'
        rows.append(row)
    # libcap is a configure/header dependency, absent from the actual LDADD.
    cap = subprocess.check_output(['dpkg-query', '-W', '-f=${source:Package}\t${source:Version}', 'libcap-dev'], text=True).split('\t')
    sources.add(tuple(cap))
    shutil.copyfile('/usr/share/doc/libcap-dev/copyright', notices / 'libcap-dev.copyright')
    for name, source in [('slirp4netns.COPYING', build / 'slirp4netns/COPYING'),
                         ('parson.LICENSE', build / 'slirp4netns/vendor/parson/LICENSE'),
                         ('libslirp.LICENSE', build / 'libslirp/LICENSE'),
                         ('libslirp.COPYRIGHT', build / 'libslirp/COPYRIGHT')]:
        shutil.copyfile(source, notices / name)
    shutil.copytree('/usr/share/common-licenses', notices / 'common-licenses')
    (materials / 'link-inventory.json').write_text(json.dumps({'inputs': rows,
        'distroSources': [{'package': p, 'version': v} for p, v in sorted(sources)],
        'releaseApproved': False, 'legalReview': 'Required; no sufficiency determination made'}, indent=2) + '\n')
    (materials / 'source-requests.txt').write_text('\n'.join(p + '=' + v for p, v in sorted(sources)) + '\n')
    return rows


if __name__ == '__main__':
    collect()
