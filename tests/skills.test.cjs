'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function storedZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const filename = Buffer.from(name), content = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + content.length;
  }
  return Buffer.concat([...local, ...central]);
}

test('skills are discovered, imported with support files, filtered, and deleted', () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-skills-'));
  process.env.HOME = home;
  const configPath = require.resolve('../src/main/configManager');
  const config = require(configPath);
  const originalGet = config.getAppSettings;
  config.getAppSettings = () => ({ disabledSkills: ['inactive'] });
  delete require.cache[require.resolve('../src/main/skillsManager')];
  const skills = require('../src/main/skillsManager');
  try {
    const saved = skills.saveSkill({ name: 'review', description: 'Review changes', instructions: '# Steps\nRead the diff.' });
    assert.equal(saved.title, 'review');
    assert.equal(saved.active, true);
    assert.match(fs.readFileSync(path.join(home, '.continuum/skills/review/SKILL.md'), 'utf8'), /Read the diff/);
    const markdown = path.join(home, 'SKILL.md');
    fs.writeFileSync(markdown, '---\nname: Inactive\ndescription: Check the build\ntriggers:\n  - check the build\n---\n# Work\nDo it.');
    assert.equal(skills.importSkill(markdown).id, 'inactive');
    assert.equal(skills.listSkills().find(item => item.id === 'inactive').active, false);
    assert.deepEqual(skills.listSkills({ includeInstructions: true }).find(item => item.id === 'inactive').triggers, ['check the build']);
    const archive = path.join(home, 'bundle.zip');
    fs.writeFileSync(archive, storedZip([['bundle/SKILL.md', '# Bundle\nUse the guide.'], ['bundle/guide.txt', 'Supporting instructions']]));
    assert.equal(skills.importSkill(archive).id, 'bundle');
    assert.equal(skills.readSkillFile('bundle', 'guide.txt'), 'Supporting instructions');
    assert.throws(() => skills.readSkillFile('bundle', '../bundle.zip'), /escapes/);
    skills.removeSkill('review');
    assert.equal(skills.listSkills().some(item => item.id === 'review'), false);
  } finally {
    config.getAppSettings = originalGet;
    delete require.cache[require.resolve('../src/main/skillsManager')];
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
