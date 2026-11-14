import Tooltip from "../Tooltip.jsx";
import { useEffect, useState } from "react";
import { IoClose } from "react-icons/io5";
import { MdMinimize } from "react-icons/md";
import { RxPanelBottomMinimized } from "react-icons/rx";

export function Titlebar() {
	const { windowAPI } = window;
	const [fullscreen, setFullscreen] = useState(false);
	const [documentFullscreen, setDocumentFullscreen] = useState(() => !!document.fullscreenElement);
	useEffect(() => {
		let changed = false;
		let disposed = false;
		const unsubscribe = windowAPI?.onFullscreenChanged?.((value) => {
			changed = true;
			setFullscreen(value);
		});
		windowAPI?.isFullscreen?.().then((value) => {
			if (!disposed && !changed) setFullscreen(value);
		}).catch(() => { /* Native state is optional in browser previews. */ });
		const onDocumentFullscreen = () => setDocumentFullscreen(!!document.fullscreenElement);
		document.addEventListener("fullscreenchange", onDocumentFullscreen);
		return () => {
			disposed = true;
			unsubscribe?.();
			document.removeEventListener("fullscreenchange", onDocumentFullscreen);
		};
	}, [windowAPI]);
	if (fullscreen || documentFullscreen) return null;
	return (
		<div className="aero-titlebar sk-toolbar sk-texture-grain sk-drag-region flex h-[28px] min-h-[28px] items-center justify-between ui-radius-top border-b pl-3.5 pr-2 bg-[var(--surface)]/95 [-webkit-app-region:drag] max-[450px]:h-[30px] max-[450px]:min-h-[30px] border-[var(--border)] ">
			<div className="flex items-center gap-2 text-xs leading-normal font-semibold tracking-[0.3px] text-[var(--text-secondary)] ">
				<span className="inline-block size-2 ui-radius-round bg-[var(--accent)] " />
				Continuum
			</div>
			<div className="flex items-center gap-3.5 [-webkit-app-region:no-drag]">
				<Tooltip content="Minimize">
					<button
						className="flex items-center justify-center h-4 w-4 ui-radius-control border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-300 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
						onClick={() => windowAPI?.minimize()}
						aria-label="Minimize"
					>
						<MdMinimize size={18} />
					</button>
				</Tooltip>
				<Tooltip content="Maximize / Restore">
					<button
						className="flex items-center justify-center h-4 w-4 ui-radius-control border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-300 text-[var(--text-secondary)] hover:text-[var(--text-primary)] "
						onClick={() => windowAPI?.maximize()}
						aria-label="Maximize / Restore"
					>
						<RxPanelBottomMinimized />
					</button>
				</Tooltip>
				<Tooltip content="Close">
					<button
						className="flex items-center justify-center h-4 w-4 ui-radius-control border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-300 text-[var(--text-secondary)] hover:text-[var(--on-accent)]"
						onClick={() => windowAPI?.close()}
						aria-label="Close"
					>
						<IoClose />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}
