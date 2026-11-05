import test from 'node:test';
import assert from 'node:assert/strict';
import { themes, themeModeFor, applyTheme } from '../src/lib/themes.mjs';
import { nextRadioChoice } from '../src/lib/radioChoices.mjs';

test('theme application sets material mode without changing theme identity', () => {
  for (const theme of themes) {
    const root = { dataset: {} };
    applyTheme(root, theme.id);
    assert.equal(root.dataset.theme, theme.id);
    assert.equal(root.dataset.themeMode, theme.mode);
    assert(['dark', 'light'].includes(theme.mode));
  }
  assert.equal(themeModeFor('midnight-find'), 'dark');
  assert.equal(themeModeFor('ember'), 'light');
});

test('theme radio navigation wraps and honors Home and End', () => {
  assert.equal(nextRadioChoice('ArrowLeft', 0, themes.length), themes.length - 1);
  assert.equal(nextRadioChoice('ArrowRight', themes.length - 1, themes.length), 0);
  assert.equal(nextRadioChoice('Home', 4, themes.length), 0);
  assert.equal(nextRadioChoice('End', 4, themes.length), themes.length - 1);
  assert.equal(nextRadioChoice('Tab', 4, themes.length), null);
});
