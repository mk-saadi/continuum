#!/usr/bin/python3
"""Relink reviewed saved inputs inside the matching disposable G.4 toolchain.
Does not install packages or alter shipping pins. Verify the review archive first.
Usage: python3 relink-workspace-network-helper.py REVIEW/materials NEW_OUTPUT
       [--replace libglib-2.0.a=/absolute/modified/library.a]
Replacement archives are explicit reviewer inputs, never release entitlements.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('materials')
parser.add_argument('output')
parser.add_argument('--replace', action='append', default=[], metavar='BASENAME=ARCHIVE')
options = parser.parse_args()
materials = pathlib.Path(options.materials).resolve(strict=True)
output = pathlib.Path(options.output).absolute()
replacements = {}
for option in options.replace:
    name, value = option.split('=', 1)
    replacement = pathlib.Path(value)
    if '/' in name or not name.endswith('.a') or not replacement.is_absolute() or replacement.is_symlink() or not replacement.is_file():
        raise SystemExit('Replacement must name an archive basename and a regular absolute archive')
    replacements[name] = replacement.resolve(strict=True)
used_replacements = set()
if output.exists() or output.is_symlink():
    raise SystemExit('Refusing to overwrite output')
inventory = json.loads((materials / 'link-inventory.json').read_text())
entries = {entry['linkName']: entry for entry in inventory['inputs']}
args = []
for line in (materials / 'slirp4netns.map').read_text().splitlines():
    if line == 'START GROUP':
        args.append('-Wl,--start-group')
    elif line == 'END GROUP':
        args.append('-Wl,--end-group')
    elif line.startswith('LOAD '):
        entry = entries[line[5:]]
        source = materials / 'link-inputs' / entry['resolved'].lstrip('/')
        with source.open('rb') as stream:
            if hashlib.sha256(stream.read()).hexdigest() != entry['sha256']:
                raise SystemExit('Link input digest mismatch: ' + str(source))
        name = source.name
        if name in replacements:
            source = replacements[name]
            used_replacements.add(name)
        args.append(str(source))
if used_replacements != set(replacements):
    raise SystemExit('Replacement does not identify a linked archive')
# All startup/runtime files are supplied from the inventory, in actual map order.
subprocess.run(['/usr/bin/gcc', '-static', '-nostdlib', '-no-pie', '-Wl,--build-id', '-o', str(output), *args], check=True)
subprocess.run(['/usr/bin/strip', str(output)], check=True)
with output.open('rb') as stream:
    print(hashlib.sha256(stream.read()).hexdigest(), str(output))
