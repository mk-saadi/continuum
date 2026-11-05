import { initializeAppearance, setAppearance } from '../../src/lib/appearance.mjs';
import { applyTheme } from '../../src/lib/themes.mjs';
initializeAppearance();
window.reviewSetAppearance = setAppearance;
window.reviewApplyTheme = value => {
  applyTheme(document.documentElement, value);
  window.setFixtureTheme?.(value);
};
