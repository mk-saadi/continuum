import { IoClose } from "react-icons/io5";
import { MdMinimize } from "react-icons/md";
import { RxPanelBottomMinimized } from "react-icons/rx";

export function Titlebar() {
	const { windowAPI } = window;
	return (
		<div className="flex h-[28px] min-h-[28px] items-center justify-between rounded-t-xl border-b pl-3.5 pr-2 bg-[var(--surface)]/95 [-webkit-app-region:drag] max-[450px]:h-[30px] max-[450px]:min-h-[30px] border-[var(--border)] ">
			<div className="flex items-center gap-2 text-xs leading-normal font-semibold tracking-[0.3px] text-[var(--text-secondary)] ">
				<span className="inline-block size-2 rounded-full bg-[var(--accent)] " />
				LLM Desktop Assistant
			</div>
			<div className="flex items-center gap-3.5 [-webkit-app-region:no-drag]">
				<button
					className="flex items-center justify-center h-4 w-4 rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-300 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
					onClick={() => windowAPI?.minimize()}
					title="Minimize"
				>
					<MdMinimize size={18} />
				</button>
				<button
					className="flex items-center justify-center h-4 w-4 rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-300 text-[var(--text-secondary)] hover:text-[var(--text-primary)] "
					onClick={() => windowAPI?.maximize()}
					title="Maximize / Restore"
				>
					<RxPanelBottomMinimized />
				</button>
				<button
					className="flex items-center justify-center h-4 w-4 rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-300 text-[var(--text-secondary)] hover:text-[var(--on-accent)]"
					onClick={() => windowAPI?.close()}
					title="Close"
				>
					<IoClose />
				</button>
			</div>
		</div>
	);
}
