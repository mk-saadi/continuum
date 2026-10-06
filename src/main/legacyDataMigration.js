'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Migration after the product was renamed from "LLM Desktop Assistant" to "Continuum".
// Electron derives userData from the application name, so existing installations keep their
// data in the legacy folder while a renamed build starts with an empty profile. This copies
// only user-owned data (never Electron caches) and leaves the legacy folder intact for recovery.
// Because the legacy folder stays on disk, the copy runs on every launch; it is guarded so that
// existing files — including directories.json written after the rename — are never overwritten.
const LEGACY_APP_NAME = 'LLM Desktop Assistant';
const DATA_ENTRIES = [
	'memory_palace.db', 'memory_palace.db-wal', 'memory_palace.db-shm',
	'attachments', 'embedding-models', 'avatars', 'App_Data', 'mcp_config.json',
];

function migrateLegacyUserData() {
	const newRoot = app.getPath('userData');
	if (path.basename(newRoot) === LEGACY_APP_NAME) return; // Still running under the legacy name.
	const oldRoot = path.join(path.dirname(newRoot), LEGACY_APP_NAME);
	if (!fs.existsSync(oldRoot)) return;

	fs.mkdirSync(newRoot, { recursive: true });

	// Carry over saved configuration so the model directory and any custom app data location survive the rename.
	let config = {};
	try { config = JSON.parse(fs.readFileSync(path.join(oldRoot, 'directories.json'), 'utf8')); } catch { /* first launch */ }

	const oldAppData = path.resolve(config.appDataDirectory ?? (fs.existsSync(path.join(oldRoot, 'memory_palace.db')) ? oldRoot : path.join(oldRoot, 'App_Data')));
	// A custom location outside the legacy profile stays valid as-is; nothing to relocate.
	const customAppData = oldAppData !== oldRoot && oldAppData !== path.join(oldRoot, 'App_Data');

	for (const entry of DATA_ENTRIES) {
		if (customAppData && entry !== 'mcp_config.json') continue; // Data lives in the custom directory that remains valid.
		const source = path.join(oldRoot, entry);
		const target = path.join(newRoot, entry);
		if (!fs.existsSync(source) || fs.existsSync(target)) continue; // Never overwrite new data.
		try {
			fs.cpSync(source, target, { recursive: true });
		} catch (error) {
			console.error(`Legacy data migration failed for ${entry}:`, error.message);
		}
	}

	config.appDataDirectory = customAppData
		? oldAppData
		: fs.existsSync(path.join(newRoot, 'memory_palace.db')) ? newRoot : path.join(newRoot, 'App_Data');

	// The legacy folder is deliberately kept on disk for recovery, so this migration runs on every
	// launch — not just once. Once the renamed profile already owns a configuration file, only fill
	// in keys it never stored and never overwrite saved values; otherwise every restart would revert
	// the model directory, app data directory, and engine timeout to the legacy profile's values.
	const configFile = path.join(newRoot, 'directories.json');
	let current = null;
	try { current = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* first launch */ }
	const merged = { ...config, ...current };
	merged.appDataDirectory = current?.appDataDirectory ?? config.appDataDirectory;
	if (current && Object.keys(merged).every((key) => Object.hasOwn(current, key))) return;
	try {
		fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
	} catch (error) {
		console.error('Legacy data migration could not update directories.json:', error.message);
	}
	console.log(`Migrated legacy app data from ${oldRoot} to ${newRoot}. The old folder was left in place.`);
}

module.exports = { migrateLegacyUserData };
