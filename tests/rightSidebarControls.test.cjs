'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const source = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'RightSidebar.jsx'),
	'utf8',
);

// 1. Three-tab keyboard navigation: no two-tab assumptions, wraps through all tabs.
// Navigation logic lives in src/lib/sidebarControls.mjs (unit-tested in
// sidebarModes.test.mjs); the sidebar must consume it for its own tab count.
const sidebarLib = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'lib', 'sidebarControls.mjs'),
	'utf8',
);
assert.ok(!source.includes('1 - index'), 'defective 1 - index navigation removed');
assert.ok(!source.includes('End" ? 1'), 'defective End -> 1 navigation removed');
assert.ok(
	source.includes('getNextTabIndex(event.key, index, sections.length)'),
	'tab navigation uses the shared helper with the live tab count',
);
assert.ok(sidebarLib.includes('(index + 1) % length'), 'ArrowRight wraps through all tabs');
assert.ok(
	sidebarLib.includes('(index + length - 1) % length'),
	'ArrowLeft wraps through all tabs',
);
assert.ok(sidebarLib.includes('if (key === "Home") return 0'), 'Home selects first tab');
assert.ok(
	sidebarLib.includes('if (key === "End") return length - 1'),
	'End selects last tab',
);
assert.ok(source.includes('aria-selected={tab === id}'), 'aria-selected stays bound to state');
assert.ok(source.includes('tabIndex={tab === id ? 0 : -1}'), 'roving tabIndex preserved');
// All panels stay mounted (hidden toggle, no conditional unmount): three per mode.
for (const id of ['controls-persona', 'controls-generation', 'controls-memory', 'controls-activity', 'controls-agents', 'controls-controls']) {
	assert.ok(source.includes(`id="${id}"`), `${id} panel still mounted`);
}

// 2. Prompt dirty-state protection and failed saves.
assert.ok(source.includes('savedPrompt'), 'saved prompt baseline tracked');
assert.ok(source.includes('isPromptDirty'), 'dirty-state helper used');
assert.ok(source.includes('isDirty'), 'dirty state consumed by safeguards');
assert.ok(source.includes('confirmReapply'), 'reapply requires explicit confirmation');
assert.ok(
	source.includes('Click Reapply again to discard them'),
	'reapply confirmation explains discard',
);
assert.ok(source.includes('Unsaved changes'), 'dirty indicator shown near save');
assert.ok(
	source.includes('Could not save instructions'),
	'failed save keeps edits with explanation',
);
// Failed agent switches restore the pre-switch text (previousPrompt), not a stale profile.
assert.ok(source.includes('previousPrompt'), 'agent-switch failure restores prior edits');

// 3. Missing / deleted presets: no dead disabled button.
assert.ok(source.includes('presetExists'), 'preset existence computed');
assert.ok(
	source.includes('was removed from the library'),
	'deleted preset explained instead of dead button',
);
assert.ok(source.includes('role="note"'), 'missing-preset explanation is exposed to AT');
assert.ok(
	!source.match(/Reapply preset[\s\S]{0,300}disabled=\{\s*disabled \|\| !agents\.some/),
	'no dead disabled Reapply button',
);

// 4. Accurate reset behavior: truthful label + complete persistence + UI refresh.
assert.ok(!source.includes('Reset to Model Defaults'), 'misleading reset label removed');
assert.ok(source.includes('Reset chat overrides'), 'truthful reset label used');
assert.ok(
	source.includes("Clears this chat"),
	'reset scope explained (assistant, prompt, sampling, memory)',
);
assert.ok(
	source.includes('saveSessionMemorySettings'),
	'reset clears memory overrides',
);
assert.ok(
	source.includes('saveSamplingParams(sessionId, modelId, null)'),
	'reset explicitly clears sampling overrides',
);
assert.ok(source.includes('onSelectAgent({ agentId: null'), 'reset clears agent selection');
assert.ok(source.includes('confirmReset'), 'reset does not silently discard unsaved edits');
assert.ok(
	source.includes("generation-settings-changed"),
	'reset refreshes sampling/memory UI',
);

// 5. Memory & Context presentation uses the shared design system.
assert.ok(source.includes('CheckboxField'), 'memory uses shared CheckboxField');
assert.ok(source.includes('Use model default'), 'per-setting default action present');
assert.ok(
	source.includes('aria-label={`Use model default for ${label}`}'),
	'default actions are labelled per setting',
);
assert.ok(source.includes('Loading memory settings'), 'memory loading state present');
assert.ok(source.includes('role="status"'), 'memory status exposed');
assert.ok(source.includes('role="alert"'), 'memory errors exposed');
assert.ok(
	source.includes('MEMORY_OPTIONS'),
	'memory options share one definition (no ad-hoc markup drift)',
);
assert.ok(
	!source.match(/<input type="checkbox" role="switch"/),
	'raw unstyled memory switch removed',
);

// 6. Cleanup: no dead duplicates or unused imports.
assert.ok(source.includes('LuBot'), 'LuBot now backs the workspace Agents tab');
assert.ok(source.includes('LuActivity'), 'LuActivity backs the workspace Activity tab');
assert.ok(
	source.includes('const sections = isWorkspace ? WORKSPACE_SECTIONS : CASUAL_SECTIONS;'),
	'single mode-driven sections declaration (no duplicates)',
);
assert.equal(
	(source.match(/const secondaryButton =/g) || []).length,
	1,
	'single secondaryButton declaration',
);
assert.ok(!source.includes('fieldClass'), 'dead fieldClass removed');
assert.ok(!source.includes('activeModel'), 'unused activeModel prop removed');

// 8. Mode-dependent layouts: casual and workspace are genuinely different.
assert.ok(source.includes('CASUAL_SECTIONS'), 'casual tab set defined');
assert.ok(source.includes('WORKSPACE_SECTIONS'), 'workspace tab set defined');
assert.ok(source.includes('isWorkspace'), 'sidebar branches on workspace mode');
assert.ok(source.includes('controls-activity'), 'workspace Activity panel exists');
assert.ok(source.includes('Recent tool activity'), 'activity reuses real tool state');
assert.ok(source.includes('Main model'), 'workspace names the handling LLM, not a persona');
assert.ok(
	(source.match(/Active agent/g) || []).length === 1,
	'persona dropdown lives only in the casual Persona panel',
);
assert.ok(
	!source.includes('Main agent'),
	'no saved persona mislabeled as the handling agent',
);
assert.ok(source.includes('Running subagents'), 'workspace distinguishes spawned subagents');
assert.ok(source.includes('Available subagents'), 'workspace lists available subagents');
assert.ok(source.includes('Sub-agent model'), 'workspace exposes the subagent model control');
assert.ok(
	source.includes('no separate'),
	'agents panel is honest about the missing subagent status feed',
);
// Permission mode, mid-run questions, and thinking budget stay in the
// composer: the sidebar must not carry a second copy of the same setting.
for (const duplicated of ['Tool permission mode', 'Mid-run questions', 'ThinkingBudgetSelector', 'Thinking budget']) {
	assert.ok(!source.includes(duplicated), `no sidebar duplicate of composer control "${duplicated}"`);
}
const composerSource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'ChatInputBar.jsx'),
	'utf8',
);
assert.ok(composerSource.includes('PermissionSelector'), 'permission mode stays in the composer');
assert.ok(composerSource.includes('allowMidRunQuestions'), 'mid-run questions stay in the composer');
assert.ok(
	fs.readFileSync(
		path.join(__dirname, '..', 'src', 'components', 'AgentSettingsPopover.jsx'),
		'utf8',
	).includes('ThinkingBudgetSelector'),
	'thinking budget stays in the composer popover',
);
// Shared sub-agent model control: same data and behavior as General Settings.
const sharedSelect = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'SubagentModelSelect.jsx'),
	'utf8',
);
for (const api of ['getSubagentModel', 'saveSubagentModel', 'getCloudProviders']) {
	assert.ok(sharedSelect.includes(api), `shared selector reuses ${api}`);
}
assert.ok(sharedSelect.includes('Follow the chat model'), 'shared selector keeps the General Settings encoding');
const generalSettings = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'settings', 'GeneralSettingsTab.jsx'),
	'utf8',
);
assert.ok(generalSettings.includes('SubagentModelSelect'), 'General Settings uses the shared selector');
assert.ok(source.includes('SubagentModelSelect'), 'workspace Agents tab uses the shared selector');
assert.ok(
	source.includes('Global setting'),
	'sidebar labels the sub-agent model as global scope, never session-level',
);
assert.ok(source.includes('AGENT_CAPABILITIES'), 'subagent capabilities share one definition');
assert.ok(source.includes('cloudChat'), 'capability availability follows the chat provider');
assert.ok(source.includes('Available') && source.includes('Unavailable'), 'capabilities show real availability');
const chatInterfaceSource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'main-app', 'ChatInterface.jsx'),
	'utf8',
);
assert.ok(
	chatInterfaceSource.includes('getSidebarMode(chatProjectId)'),
	'mode derives from session/tab project binding in ChatInterface',
);
for (const prop of ['isWorkspace={isWorkspaceChat}', 'projectName={project?.name', 'modelName={activeModelName', 'cloudChat={activeChatProvider.type', 'runtime={{']) {
	assert.ok(chatInterfaceSource.includes(prop), `ChatInterface passes ${prop} to the sidebar`);
}
for (const removed of ['permission={{', 'midRun={{']) {
	assert.ok(!chatInterfaceSource.includes(removed), `ChatInterface no longer duplicates ${removed} into the sidebar`);
}
assert.ok(source.includes('prevMode'), 'sidebar resets its tab when the mode changes');
assert.ok(
	source.includes("setTab(isWorkspace ? \"activity\" : \"persona\")"),
	'mode switch lands on the mode default tab without stale selection',
);
assert.ok(
	fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sidebarControls.mjs'), 'utf8')
		.includes('chatProjectId != null'),
	'mode helper keys on project binding, not sidebar state',
);
// Workspace project configuration stays out of the sidebar.
assert.ok(!source.includes('rootDirectory'), 'no workspace-wide project config in sidebar');
assert.ok(!source.includes('updateProject'), 'no project mutation controls in sidebar');

// 9. Tab overflow: short labels that fit w-80, shrinkable buttons, truncated text.
for (const label of ['Persona', 'Generation', 'Memory', 'Activity', 'Agents', 'Controls']) {
	assert.ok(source.includes(`label: "${label}"`), `short tab label "${label}" fits the sidebar`);
}
assert.ok(!source.includes('Agent & Persona'), 'long overflowing casual label removed');
assert.ok(!source.includes('Memory & Context'), 'long overflowing casual label removed');
assert.ok(source.includes('min-w-0 flex-1'), 'tab buttons can shrink into the available width');
assert.ok(source.includes('className="truncate"'), 'tab labels truncate instead of overflowing');
assert.ok(source.includes('overflow-hidden'), 'tab bar clips nothing outside the sidebar');
assert.ok(
	!source.match(/whitespace-nowrap border-b-2 px-2 py-3/),
	'old fixed-padding nowrap tab buttons removed',
);

// 7. Functional: the documented complete-reset sequence restores model defaults.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'right-sidebar-reset-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	if (name === 'electron')
		return { app: { isReady: () => true, getPath: () => dir } };
	return originalLoad.call(this, name, ...args);
};
try {
	const { initDatabase, closeDatabase } = require('../src/main/db');
	const profiles = require('../src/main/profileSettings');
	const sessions = require('../src/main/sessionManager');
	const agents = require('../src/main/agentManager');
	initDatabase();
	try {
		profiles.saveProfileSettings(null, {
			systemPrompt: 'Global instructions',
			temperature: 0.7,
			memoryEnabled: true,
			compactionEnabled: true,
		});
		profiles.saveProfileSettings('/model-a', {
			systemPrompt: 'Model instructions',
			temperature: 0.3,
		});
		const agent = agents.createAgent({
			name: 'Helper',
			description: '',
			system_prompt: 'Agent prompt',
		});
		agents.applyAgent('reset-chat', agent.id, '/model-a');
		sessions.saveSessionSamplingParams('reset-chat', '/model-a', { temperature: 0 });
		profiles.saveSessionMemorySettings('reset-chat', '/model-a', {
			memoryEnabled: false,
			compactionEnabled: false,
		});
		agents.saveSessionPrompt('reset-chat', 'Custom chat instructions', '/model-a');

		let state = profiles.getSessionSettings('reset-chat', '/model-a');
		assert.equal(state.source, 'chat', 'chat shows overridden before reset');
		assert.ok(Object.keys(state.overrides).length > 0, 'overrides present before reset');

		// Mirror RightSidebar.resetOverrides: agent + memory + explicit sampling clear.
		agents.applyAgent('reset-chat', null, '/model-a');
		profiles.saveSessionMemorySettings('reset-chat', '/model-a', {
			memoryEnabled: null,
			compactionEnabled: null,
		});
		sessions.saveSessionSamplingParams('reset-chat', '/model-a', null);

		state = profiles.getSessionSettings('reset-chat', '/model-a');
		assert.deepEqual(state.overrides, {}, 'complete reset clears every chat override');
		assert.equal(state.effective.temperature, 0.3, 'sampling falls back to model default');
		assert.equal(state.effective.systemPrompt, 'Model instructions', 'prompt falls back to model default');
		assert.equal(state.effective.memoryEnabled, true, 'memory falls back to default');
		assert.equal(state.effective.compactionEnabled, true, 'compaction falls back to default');
		assert.equal(state.source, 'model', 'source returns to model after reset');
	} finally {
		closeDatabase();
	}
} finally {
	Module._load = originalLoad;
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
	'Right sidebar controls: tab navigation, dirty-state guards, missing presets, truthful reset, memory presentation, cleanup, mode layouts, tab overflow, and reset persistence passed.',
);
