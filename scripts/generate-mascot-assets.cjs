// Run from the repository root. Design exports remain untouched.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const source = 'design/mascot/animated-webp';
const destination = 'src/assets/mascot';

async function generate() {
    const rows = fs.readFileSync(path.join(source, 'manifest.csv'), 'utf8')
        .trim().split('\n').slice(1).map(line => {
            const cells = line.trim().split(',');
            return {
                filename: cells[0], state: cells[1], part: cells[2], playback: cells[3],
                version: Number(cells[4]), size: cells[5], width: Number(cells[6]),
                height: Number(cells[7]), duration: Number(cells[8]),
            };
        }).filter(row => row.state !== 'turbo');
    const selected = rows.filter(row => ['small', 'full'].includes(row.size) && row.version === Math.max(
        ...rows.filter(candidate => candidate.state === row.state && candidate.part === row.part)
            .map(candidate => candidate.version),
    ));
    fs.mkdirSync(destination, { recursive: true });
    // Only the generated runtime directory is pruned; historical design exports are never changed.
    const expected = new Set(selected.flatMap(row => [row.filename, row.filename.replace('.webp', '.png')]));
    for (const name of fs.readdirSync(destination)) {
        if (/^continuum-.*\.(png|webp)$/.test(name) && !expected.has(name)) fs.unlinkSync(path.join(destination, name));
    }
    for (const row of selected) {
        fs.copyFileSync(path.join(source, row.filename), path.join(destination, row.filename));
        row.static = row.filename.replace('.webp', '.png');
        await sharp(path.join(source, row.filename), { animated: false }).png().toFile(path.join(destination, row.static));
    }
    fs.writeFileSync('src/lib/mascotCatalog.json', JSON.stringify(selected, null, 2) + '\n');
}
generate().catch(error => { console.error(error); process.exitCode = 1; });
