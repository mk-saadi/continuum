"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { getAppSettings } = require("./configManager");

const skillsRoot = () => path.join(os.homedir(), ".continuum", "skills");
const validId = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
function assertId(id) {
	if (!validId(id))
		throw new Error("Skill name must use lowercase letters, numbers, hyphens, or underscores.");
	return id;
}
function skillPath(id) {
	return path.join(skillsRoot(), assertId(id));
}
function metadata(id, content) {
	let fields = {};
	const body = content.replace(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/, (_, yaml) => {
		let current = null;
		for (const line of yaml.split(/\r?\n/)) {
			const field = line.match(/^([\w-]+):\s*(.*)$/);
			if (field) {
				current = field[1];
				let value = field[2].trim();
				if (value.startsWith('"') || value.startsWith("[")) {
					try {
						value = JSON.parse(value);
					} catch {
						/* Keep the YAML scalar. */
					}
				} else value = value.replace(/^'|'$/g, "");
				fields[current] = value;
			} else if (current && /^\s+/.test(line)) {
				if (Array.isArray(fields[current])) continue;
				if (line.trim().startsWith("- ")) {
					if (!Array.isArray(fields[current])) fields[current] = [];
					fields[current].push(
						line
							.trim()
							.slice(2)
							.replace(/^['"]|['"]$/g, ""),
					);
				} else if (fields[current] === ">" || fields[current] === "|") fields[current] = line.trim();
				else fields[current] += ` ${line.trim()}`;
			}
		}
		return "";
	});
	const title = fields.name || body.match(/^#\s+(.+)$/m)?.[1] || id;
	const description =
		fields.description ||
		body
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("#")) ||
		"";
	const triggers = Array.isArray(fields.triggers)
		? fields.triggers
		: typeof fields.triggers === "string"
			? fields.triggers.split(",")
			: [];
	return {
		id,
		title: String(title),
		description: String(description).slice(0, 500),
		triggers: triggers.map((value) => String(value).trim()).filter(Boolean),
		instructions: content,
	};
}
function listSkills({ includeInstructions = false } = {}) {
	if (!fs.existsSync(skillsRoot())) return [];
	const disabled = new Set(getAppSettings().disabledSkills);
	return fs
		.readdirSync(skillsRoot(), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && validId(entry.name))
		.flatMap((entry) => {
			try {
				const dir = skillPath(entry.name);
				if (
					fs.lstatSync(dir).isSymbolicLink() ||
					!fs.statSync(path.join(dir, "SKILL.md")).isFile() ||
					fs.statSync(path.join(dir, "SKILL.md")).size > 200000
				)
					return [];
				const content = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
				const item = metadata(entry.name, content);
				if (!includeInstructions) delete item.instructions;
				item.active = !disabled.has(entry.name);
				return [item];
			} catch {
				return [];
			}
		});
}
function saveSkill({ name, description = "", instructions, projectId = null }) {
	const id = assertId(name);
	if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 200000)
		throw new Error("Skill instructions must contain 1–200,000 characters.");
	if (typeof description !== "string" || description.length > 1000)
		throw new Error("Invalid skill description.");
	if (projectId) require("./projectManager").getProject(projectId);
	const dir = skillPath(id);
	if (fs.existsSync(dir)) throw new Error("A skill with this name already exists.");
	fs.mkdirSync(dir, { recursive: true });
	const yaml = (value) => JSON.stringify(value);
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		`---\nname: ${yaml(id)}\ndescription: ${yaml(description)}\n---\n\n${instructions.trim()}\n`,
		{ flag: "wx" },
	);
	if (projectId) enableForProject(projectId, id);
	return listSkills().find((skill) => skill.id === id);
}
function enableForProject(projectId, id) {
	const projects = require("./projectManager");
	const project = projects.getProject(projectId);
	projects.updateProject(projectId, { enabledSkills: [...new Set([...project.enabledSkills, id])] });
}
function removeSkill(id) {
	const dir = skillPath(id);
	if (!fs.existsSync(dir)) throw new Error("Skill not found.");
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Cannot delete a linked skill.");
	fs.rmSync(dir, { recursive: true });
	return { deleted: true };
}
function activeProjectSkills(projectId) {
	if (!projectId) return [];
	const enabled = new Set(require("./projectManager").getProject(projectId).enabledSkills);
	return listSkills({ includeInstructions: true }).filter((skill) => skill.active && enabled.has(skill.id));
}
function readSkillFile(id, relativePath) {
	if (
		typeof relativePath !== "string" ||
		!relativePath ||
		relativePath.includes("\0") ||
		path.isAbsolute(relativePath)
	)
		throw new Error("Invalid skill file path.");
	const root = skillPath(id);
	const target = path.resolve(root, relativePath);
	if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Skill file path escapes its folder.");
	let current = root;
	for (const part of path.relative(root, target).split(path.sep)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Linked skill files are not supported.");
	}
	const stat = fs.statSync(target);
	if (!stat.isFile() || stat.size > 200000) throw new Error("Skill file must be a text file under 200 KB.");
	const content = fs.readFileSync(target, "utf8");
	if (content.includes("\0")) throw new Error("Binary skill files cannot be loaded.");
	return content;
}
function importSkill(source, projectId = null) {
	if (projectId) require("./projectManager").getProject(projectId);
	if (typeof source !== "string" || !path.isAbsolute(source))
		throw new Error("Choose a skill file or folder.");
	const stat = fs.statSync(source);
	const folder = stat.isDirectory();
	const extension = path.extname(source).toLowerCase();
	const sourceName =
		!folder && extension === ".md"
			? metadata("imported", fs.readFileSync(source, "utf8")).title
			: path.basename(source, folder ? undefined : path.extname(source));
	const id = sourceName
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	assertId(id);
	const target = skillPath(id);
	if (fs.existsSync(target)) throw new Error("A skill with this name already exists.");
	try {
		if (folder) {
			if (!fs.statSync(path.join(source, "SKILL.md")).isFile())
				throw new Error("Folder must contain SKILL.md.");
			fs.cpSync(source, target, {
				recursive: true,
				filter: (item) => !fs.lstatSync(item).isSymbolicLink(),
			});
		} else if (extension === ".md") {
			fs.mkdirSync(target, { recursive: true });
			fs.copyFileSync(source, path.join(target, "SKILL.md"));
		} else if (extension === ".zip") {
			const bytes = fs.readFileSync(source);
			if (bytes.length > 25 * 1024 * 1024) throw new Error("Skill archive is too large.");
			const entries = [];
			let offset = 0;
			while ((offset = bytes.indexOf(Buffer.from("PK\x01\x02"), offset)) !== -1) {
				const method = bytes.readUInt16LE(offset + 10),
					size = bytes.readUInt32LE(offset + 20);
				const nameLength = bytes.readUInt16LE(offset + 28),
					extra = bytes.readUInt16LE(offset + 30),
					comment = bytes.readUInt16LE(offset + 32);
				const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
				const local = bytes.readUInt32LE(offset + 42);
				const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
				if (!name.endsWith("/")) entries.push({ name, method, size, start });
				offset += 46 + nameLength + extra + comment;
			}
			const prefix = entries
				.find((entry) => /(^|\/)SKILL\.md$/.test(entry.name))
				?.name.replace(/SKILL\.md$/, "");
			if (prefix == null) throw new Error("Archive must contain SKILL.md.");
			fs.mkdirSync(target, { recursive: true });
			let total = 0;
			for (const entry of entries.filter((item) => item.name.startsWith(prefix))) {
				const relative = entry.name.slice(prefix.length);
				if (
					!relative ||
					relative
						.split("/")
						.some((part) => !part || part === "." || part === ".." || part.includes("\\"))
				)
					continue;
				const output = path.join(target, relative);
				const compressed = bytes.subarray(entry.start, entry.start + entry.size);
				const content =
					entry.method === 0
						? compressed
						: entry.method === 8
							? zlib.inflateRawSync(compressed, { maxOutputLength: 50 * 1024 * 1024 - total })
							: null;
				if (!content || (total += content.length) > 50 * 1024 * 1024)
					throw new Error("Unsupported or oversized skill archive.");
				fs.mkdirSync(path.dirname(output), { recursive: true });
				fs.writeFileSync(output, content);
			}
		} else throw new Error("Choose a Markdown file, ZIP archive, or folder.");
		if (
			!fs.existsSync(path.join(target, "SKILL.md")) ||
			fs.statSync(path.join(target, "SKILL.md")).size > 200000
		)
			throw new Error("Imported skill must contain a SKILL.md under 200 KB.");
	} catch (error) {
		if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
		throw error;
	}
	if (projectId) enableForProject(projectId, id);
	return listSkills().find((skill) => skill.id === id);
}
module.exports = {
	skillsRoot,
	listSkills,
	saveSkill,
	removeSkill,
	importSkill,
	activeProjectSkills,
	readSkillFile,
	validId,
};
