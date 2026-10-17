'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Phase 3 guard: the sidebar layout spacers must not animate layout dimensions.
// Opening/closing a sidebar may change the transcript's available width exactly
// once (a single layout), but the transition itself must only move the visual
// panel with translate/opacity so the transcript is not re-laid-out on every
// animation frame. This is a structural companion to sidebarAnimation.ui.cjs,
// which measures the real behaviour.
const chatInterface = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'main-app', 'ChatInterface.jsx'),
  'utf8',
);
const rightSidebar = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'RightSidebar.jsx'),
  'utf8',
);

// 1. The spacers exist and keep the exact collapsed/expanded geometry.
assert.ok(chatInterface.includes('id="chat-sidebar"'), 'left sidebar spacer present');
assert.ok(rightSidebar.includes('id="right-sidebar"'), 'right sidebar spacer present');
assert.ok(chatInterface.includes('w-[272px]'), 'left expanded width preserved');
assert.ok(chatInterface.includes('max-[650px]:w-[220px]'), 'left responsive width preserved');
assert.ok(rightSidebar.includes('w-80'), 'right expanded width preserved');
assert.ok(chatInterface.includes('"w-0"'), 'left sidebar collapses to zero width');
assert.ok(rightSidebar.includes('"w-0"'), 'right sidebar collapses to zero width');

// 2. No spacer animates width or all properties.
assert.ok(
  !/id="chat-sidebar"[\s\S]{0,400}transition-all/.test(chatInterface),
  'left sidebar must not use transition-all',
);
assert.ok(
  !/id="right-sidebar"[\s\S]{0,600}transition-all/.test(rightSidebar),
  'right sidebar must not use transition-all',
);
assert.ok(!chatInterface.includes('transition-[width'), 'left spacer must not transition width');
assert.ok(!rightSidebar.includes('transition-[width'), 'right spacer must not transition width');

// 3. Both animated panels transition only transform + opacity (no layout).
const panelTransition = /transition-\[translate,opacity\]/g;
assert.equal(
  (chatInterface.match(panelTransition) || []).length,
  1,
  'left panel transitions translate+opacity exactly once',
);
assert.equal(
  (rightSidebar.match(panelTransition) || []).length,
  1,
  'right panel transitions translate+opacity exactly once',
);
assert.ok(chatInterface.includes('-translate-x-full'), 'left panel slides off-canvas when closed');
assert.ok(rightSidebar.includes('translate-x-full'), 'right panel slides off-canvas when closed');

// 4. Reduced-motion handling is preserved on the animated panels.
assert.ok(chatInterface.includes('motion-reduce:transition-none'), 'left panel honours reduced motion');
assert.ok(rightSidebar.includes('motion-reduce:transition-none'), 'right panel honours reduced motion');

// 5. Accessibility state stays bound to the open flag and clips the panel.
assert.ok(chatInterface.includes('aria-hidden={!isSidebarOpen}'), 'left aria-hidden bound to open');
assert.ok(chatInterface.includes('inert={isSidebarOpen ? undefined : ""}'), 'left inert bound to open');
assert.ok(rightSidebar.includes('aria-hidden={!open}'), 'right aria-hidden bound to open');
assert.ok(rightSidebar.includes('inert={open ? undefined : ""}'), 'right inert bound to open');
assert.ok(chatInterface.includes('overflow-hidden'), 'panels still clip their content');

// 6. The transcript itself must not be pinned to the expanded-sidebar width:
// its scroll container keeps the flexible sizing classes.
assert.ok(
  chatInterface.includes('min-h-0 flex-1 overflow-y-auto'),
  'transcript keeps its flexible scroll container',
);

console.log(
  'Sidebar animation strategy: spacers own the transcript width, panels transition translate/opacity only, geometry, reduced motion and accessibility state preserved.',
);
