import React, { useEffect, useRef, useState } from "react";
import { ToastProvider, useToast } from "react-toast-master";
import "../../styles/app-toast.css";

// An isolated provider keeps ordinary notifications from dismissing an
// unanswered approval via the package's latest-toast dismissal API.
export default function ToolApprovalToast({ approval }) {
	return (
		<ToastProvider>
			<ApprovalNotification approval={approval} />
		</ToastProvider>
	);
}

function ApprovalNotification({ approval }) {
	const { toastMaster, hideToast } = useToast();
	useEffect(() => {
		// Deferring also prevents duplicate notifications in React StrictMode.
		const timer = setTimeout(
			() =>
				toastMaster({
					type: "customStay",
					position: "top",
					transition: "down",
					custom: (
						<ApprovalCard
							approval={approval}
							onResolved={hideToast}
						/>
					),
				}),
			0,
		);
		return () => clearTimeout(timer);
	}, [approval, toastMaster, hideToast]);
	return null;
}

function ApprovalCard({ approval, onResolved }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const cardRef = useRef(null);
	const responding = useRef(false);
	useEffect(() => {
		// customStay normally dismisses on Escape. An approval must stay visible
		// until an explicit decision; never leave the agent waiting invisibly.
		const keepApprovalVisible = (event) => {
			if (event.key === "Escape" && cardRef.current?.getClientRects().length) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		};
		window.addEventListener("keydown", keepApprovalVisible, true);
		return () => window.removeEventListener("keydown", keepApprovalVisible, true);
	}, []);
	const respond = async (action) => {
		if (responding.current) return;
		responding.current = true;
		setError("");
		setBusy(true);
		try {
			await window.chatAPI.respondToToolApproval(approval.requestId, approval.approvalId, action);
			onResolved();
		} catch (error) {
			setError(error.message);
			responding.current = false;
			setBusy(false);
		}
	};
	return (
		<div
			ref={cardRef}
			role="alertdialog"
			aria-busy={busy}
			aria-labelledby="tool-approval-title"
			className="app-approval-toast aero-toast-surface ui-radius-surface"
		>
			<p id="tool-approval-title">Allow {approval.casualTerminal ? "terminal tool" : approval.name}?</p>
			<pre className="my-3 max-h-52 overflow-auto whitespace-pre-wrap break-all ui-radius-control bg-[var(--input)] p-3 text-xs text-[var(--text-secondary)]">
				{JSON.stringify(approval.args, null, 2)}
			</pre>
			{approval.casualTerminal && (
				<p className="text-xs">
					This tool can execute commands on your computer. Tool: {approval.name}
				</p>
			)}
			{approval.rememberable && <p className="my-2 text-xs">{approval.rememberLabel}</p>}
            {error && <p role="alert" className="my-2 text-xs text-[var(--error)]">{error}</p>}
            <div className="app-approval-actions">
                {!approval.casualTerminal && <button type="button" disabled={busy} onClick={() => respond("allow")} className="aero-control sk-button aero-fill sk-fill ui-radius-control px-3 py-1.5 text-xs disabled:opacity-50">Allow once</button>}
                {approval.rememberable && <>
                    <button type="button" disabled={busy} onClick={() => respond("chat")} className="aero-control sk-button ui-radius-control px-3 py-1.5 text-xs disabled:opacity-50">Allow for this chat</button>
                    <button type="button" disabled={busy} onClick={() => respond("project")} className="aero-control sk-button ui-radius-control px-3 py-1.5 text-xs disabled:opacity-50">{approval.casualTerminal ? "Always allow" : "Always allow in this project"}</button>
                </>}
                <button type="button" disabled={busy} onClick={() => respond("deny")} className="app-approval-deny">Deny</button>
            </div>
        </div>
    );
}
