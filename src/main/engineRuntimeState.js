"use strict";
// Detached llama-server processes outlive Electron when the app is stopped with
// SIGINT/SIGTERM (dev Ctrl+C) or crashes. Because the app tracks its engines in
// memory only, a surviving orphan makes the next launch load another model
// beside it while the UI has no record of the first. This module persists every
// engine a session owns and reaps leftovers on the next start.

const fs = require("node:fs");
const path = require("node:path");
const { exec, execFileSync } = require("node:child_process");

// Kill a process and everything in its process group. `detached` spawns make
// the child a group leader, so the negative PID reaches the whole tree; the
// positive-PID fallback covers a process that is no longer a group leader.
function killProcessTree(pid, signal = "SIGTERM", platform = process.platform) {
	if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
	if (platform === "win32") {
		return new Promise((resolve) => {
			exec(`taskkill /pid ${pid} /T /F`, () => resolve());
		});
	}
	return new Promise((resolve) => {
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if (error.code === "ESRCH") {
				try {
					process.kill(pid, signal);
				} catch {
					// Already gone.
				}
			}
		}
		resolve();
	});
}

// Synchronous variant for signal handlers, where promises never get to settle.
function killProcessTreeSync(pid, platform = process.platform) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (platform === "win32") {
		try {
			execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			// Already gone.
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

function readCommandLine(pid, platform = process.platform) {
	try {
		if (platform === "linux")
			return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
		if (platform === "darwin")
			return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
		if (platform === "win32")
			return execFileSync(
				"wmic",
				["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
				{ encoding: "utf8" },
			).trim();
	} catch {
		return "";
	}
	return "";
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is owned by another user.
		return error.code === "EPERM";
	}
}

function normalizeEntry(entry) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
	if (!Number.isInteger(entry.enginePid) || entry.enginePid <= 0) return null;
	return {
		enginePid: entry.enginePid,
		port: Number.isInteger(entry.port) ? entry.port : null,
		modelPath: typeof entry.modelPath === "string" ? entry.modelPath : null,
		engineCommand: typeof entry.engineCommand === "string" ? entry.engineCommand : null,
	};
}

function createEngineRuntimeState({
	stateFile,
	engineBinary = "llama-server",
	platform = process.platform,
	killTree = (pid, signal) => killProcessTree(pid, signal, platform),
	killTreeSync: killSync = (pid) => killProcessTreeSync(pid, platform),
	onWarning = (message) => console.warn(message),
	onError = (message) => console.error(message),
	now = () => new Date().toISOString(),
} = {}) {
	function readMeta() {
		if (!stateFile) return null;
		try {
			const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
			return raw;
		} catch {
			return null;
		}
	}

	function readAll() {
		const meta = readMeta();
		if (!meta || !Array.isArray(meta.engines)) return [];
		return meta.engines.map(normalizeEntry).filter(Boolean);
	}

	function persistApp() {
		return Number.isInteger(readMeta()?.appPid) ? readMeta().appPid : process.pid;
	}

	// Persist the complete set of engines owned by this app instance.
	function save(entries) {
		if (!stateFile) return;
		const engines = (entries ?? []).map(normalizeEntry).filter(Boolean);
		try {
			fs.mkdirSync(path.dirname(stateFile), { recursive: true });
			const temporary = `${stateFile}.${process.pid}.tmp`;
			fs.writeFileSync(
				temporary,
				JSON.stringify({ appPid: process.pid, engines, updatedAt: now() }),
				{ mode: 0o600 },
			);
			fs.renameSync(temporary, stateFile);
		} catch (error) {
			onError(`Could not persist engine runtime state: ${error.message}`);
		}
	}

	function removeFile() {
		if (!stateFile) return;
		try {
			fs.unlinkSync(stateFile);
		} catch (error) {
			if (error.code !== "ENOENT") onError(`Could not clear engine runtime state: ${error.message}`);
		}
	}

	// Drop one engine from the persisted set. A stale close event from a
	// replaced engine must not erase an engine that replaced it.
	function clear(enginePid) {
		if (enginePid === undefined) {
			removeFile();
			return;
		}
		const all = readAll();
		const remaining = all.filter((entry) => entry.enginePid !== enginePid);
		if (remaining.length === all.length) return;
		if (!remaining.length) removeFile();
		else save(remaining);
	}

	// Never kill a PID that was reused by an unrelated process: the recorded
	// command line must still reference the model or the engine binary.
	function isRecordedEngineProcess(entry) {
		if (!entry || !isProcessAlive(entry.enginePid)) return false;
		const command = readCommandLine(entry.enginePid, platform);
		if (!command) return false;
		if (entry.modelPath && command.includes(entry.modelPath)) return true;
		const binary = path
			.basename(
				typeof entry.engineCommand === "string" && entry.engineCommand
					? entry.engineCommand
					: engineBinary,
			)
			.toLowerCase();
		return Boolean(binary) && command.toLowerCase().includes(binary);
	}

	// Kill every leftover engine recorded by a previous (dead) app instance.
	async function reap() {
		const all = readAll();
		if (!all.length) return false;
		const meta = readMeta();
		const appPid = meta?.appPid;
		// A live app instance owns its engines; only reap when the owner is gone.
		if (Number.isInteger(appPid) && appPid !== process.pid && isProcessAlive(appPid)) return false;
		let reaped = false;
		for (const entry of all) {
			if (!isRecordedEngineProcess(entry)) continue;
			onWarning(
				`[engine] Cleaning up orphaned ${engineBinary} process ${entry.enginePid} from a previous session.`,
			);
			await killTree(entry.enginePid, "SIGKILL");
			reaped = true;
		}
		removeFile();
		return reaped;
	}

	return { readAll, save, clear, reap, isRecordedEngineProcess, killTreeSync: killSync };
}

module.exports = {
	createEngineRuntimeState,
	killProcessTree,
	killProcessTreeSync,
	isProcessAlive,
	readCommandLine,
};
