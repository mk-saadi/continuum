'use strict';
const isCommand = name => name === 'execute_command' || name === 'run_tests';
const isOpaqueGit = name => ['git_stage', 'git_unstage', 'git_stash', 'git_commit', 'git_create_branch', 'git_switch'].includes(name);
module.exports = { isCommand, isOpaqueGit };
