'use strict';
// Code-owned main entry for the LOCAL DEVELOPER AppImage (`npm run dist:local`).
//
// The local packaging target sets package.json "main" to this file via
// electron-builder extraMetadata. A normal production package keeps "main" as
// ../../main.js, so this entry is never the running module of a production
// AppImage. It shares the primary application profile: productName stays
// "Continuum", so app.getPath('userData') is unchanged.
//
// This file only enables the source-local entitlement; elevated private/host
// networking still requires the existing settings consent flow.
const { app } = require('electron');
const local = require('./localDevelopmentNetwork');

local.initialize();

if (local.active()) {
  // Visible, non-interactive identity. This is display only; entitlement is
  // decided by code (entry identity + independently verified resources), never
  // by this banner or any renderer input.
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`{
        const label = document.createElement('div');
        label.textContent = 'LOCAL DEVELOPMENT · NON-DISTRIBUTABLE';
        label.style = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#7f1d1d;color:white;text-align:center;font:12px sans-serif;pointer-events:none';
        document.body.appendChild(label);
      }`).catch(() => {});
    });
  });
} else {
  // Fail closed for the entitlement, not for the application: an ineligible
  // build simply keeps elevated local networking unavailable.
  console.error('[local-development] This entry is not eligible in the current build; local development entitlement stays unavailable.');
}

require('../../main.js');
