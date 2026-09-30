"use strict";

// Broad, dialect-agnostic mutation verbs across SQL, Mongo, and Redis query/command strings.
// NOTE: only run this against strings you know are database queries (e.g. args passed to
// a Mongo/SQL tool, or a command string you've already identified as invoking a DB client).
// Do NOT run this against general-purpose shell commands — "npm update" / "apt update" /
// "brew update" will false-positive on the UPDATE verb below.
const MUTATION_VERBS = [
	/\bDELETE\s+FROM\b/i,
	/\bTRUNCATE\b/i,
	/\bDROP\s+(TABLE|DATABASE|COLLECTION|INDEX)\b/i,
	/\bUPDATE\b.*\bSET\b/i, // SQL UPDATE ... SET, not bare "update"
	/\bALTER\s+TABLE\b/i,
	/\.deleteMany\s*\(/i,
	/\.updateMany\s*\(/i,
	/\.remove\s*\(/i,
	/\.drop\s*\(/i,
	/\bFLUSHALL\b/i,
	/\bFLUSHDB\b/i,
];

const NARROW_SCOPE_SIGNALS = [
	/\b_id\s*:\s*\{?\s*\$in\s*:\s*\[/i,
	/\bWHERE\s+\w*id\w*\s*(=|IN\s*\()/i,
	/\b_id\s*:\s*['"$]/i,
];

const BROAD_SCOPE_SIGNALS = [
	/\$ne\s*:/,
	/\$nin\s*:/,
	/\$exists\s*:\s*false/i,
	/!=|<>/,
	/\bNOT\s+IN\b/i,
	/\bIS\s+NOT\b/i,
	/\b1\s*=\s*1\b/,
	/\bWHERE\s+TRUE\b/i,
];

function requiresConfirmation(dbCommand) {
	const isMutation = MUTATION_VERBS.some((pattern) => pattern.test(dbCommand));
	if (!isMutation) return false;
	const hasNarrowScope = NARROW_SCOPE_SIGNALS.some((pattern) => pattern.test(dbCommand));
	const hasBroadScope = BROAD_SCOPE_SIGNALS.some((pattern) => pattern.test(dbCommand));
	return !hasNarrowScope || hasBroadScope;
}

module.exports = { requiresConfirmation };
