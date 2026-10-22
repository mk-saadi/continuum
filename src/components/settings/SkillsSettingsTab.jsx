import React, { useEffect, useState } from "react";
import { LuSparkles } from "react-icons/lu";
import {
	SettingsButton,
	SettingsCard,
	SettingsCheckRow,
	SettingsEmpty,
	SettingsMessage,
} from "./SettingsSection";

export default function SkillsSettingsTab() {
	const [skills, setSkills] = useState([]);
	const [settings, setSettings] = useState(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	async function refresh() {
		const [items, config] = await Promise.all([window.api.listSkills(), window.api.getAppSettings()]);
		setSkills(items);
		setSettings(config);
	}
	useEffect(() => {
		refresh().catch((err) => setError(err.message));
	}, []);
	async function action(run) {
		setBusy(true);
		setError("");
		try {
			await run();
			await refresh();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<SettingsCard
			icon={LuSparkles}
			title="Global skills"
			description="Available across projects when active."
			action={
				<>
					<SettingsButton
						variant="primary"
						className="primary"
						disabled={busy}
						title="Import a .md or .zip skill file"
						onClick={() => action(() => window.api.importSkill())}
					>
						Import Skill File
					</SettingsButton>
					<SettingsButton
						disabled={busy}
						title="Import a folder containing SKILL.md"
						onClick={() => action(() => window.api.importSkillFolder())}
					>
						Import Skill Folder
					</SettingsButton>
				</>
			}
		>
			<SettingsMessage>{error}</SettingsMessage>
			{!settings ? (
				<p
					role="status"
					className="text-[11px] text-[var(--text-muted)]"
				>
					Loading skills…
				</p>
			) : !skills.length ? (
				<SettingsEmpty>No skills imported yet.</SettingsEmpty>
			) : (
				<ul className="divide-y divide-[var(--border)]">
					{skills.map((skill) => (
						<li
							key={skill.id}
							className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
						>
							<div className="min-w-0 flex-1">
								<h4 className="truncate text-xs font-semibold">{skill.title}</h4>
								<p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
									{skill.description}
								</p>
								<code className="mt-1 block truncate font-mono text-[10px] text-[var(--text-secondary)]">
									@{skill.id}
								</code>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<SettingsCheckRow
									role="switch"
									label={skill.active ? "Active" : "Inactive"}
									checked={skill.active}
									disabled={busy}
									className="px-2 py-1"
									onChange={(event) =>
										action(() =>
											window.api.saveAppSettings({
												disabledSkills: event.target.checked
													? settings.disabledSkills.filter(
															(id) => id !== skill.id,
														)
													: [...settings.disabledSkills, skill.id],
											}),
										)
									}
								/>
								<SettingsButton
									disabled={busy}
									aria-label={`Delete ${skill.title}`}
									onClick={() => action(() => window.api.deleteSkill(skill.id))}
								>
									Delete
								</SettingsButton>
							</div>
						</li>
					))}
				</ul>
			)}
		</SettingsCard>
	);
}
