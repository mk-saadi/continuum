import React, { useCallback, useEffect, useRef } from "react";
import { useToast } from "react-toast-master";
import { LuCircleAlert, LuTriangleAlert, LuInfo, LuCheck, LuX } from "react-icons/lu";
import "../styles/app-toast.css";

let pendingNotification;

// Keep one notification visible: the package's public dismissal API defaults
// to the latest toast. Actionable approval dialogs remain in the chat.
export function useAppToast() {
	const { toastMaster, hideToast } = useToast();
	return useCallback(
		(message, severity = "error") => {
			if (!message) return;
			clearTimeout(pendingNotification);
			hideToast();
			pendingNotification = setTimeout(() => {
				const Icon =
					{ error: LuCircleAlert, warning: LuTriangleAlert, info: LuInfo, success: LuCheck }[
						severity
					] || LuInfo;
				toastMaster({
					type: "customStay",
					position: "bottomRight",
					transition: "top",
					shadow: "none",
					timeout: severity === "error" ? 15000 : 9000,
					custom: (
						<section
							className="app-toast material-toast-surface"
							data-severity={severity}
							role={severity === "error" || severity === "warning" ? "alert" : "status"}
						>
							<Icon
								className="app-toast-icon"
								aria-hidden="true"
							/>
							<div className="app-toast-content">
								<strong>
									{
										{
											error: "Something went wrong",
											warning: "Please check",
											info: "Chat notice",
											success: "Done",
										}[severity]
									}
								</strong>
								<p>{String(message)}</p>
							</div>
							<button
								type="button"
								className="app-toast-close"
								aria-label="Dismiss notification"
								onClick={() => hideToast()}
							>
								<LuX aria-hidden="true" />
							</button>
						</section>
					),
				});
			}, 400);
		},
		[toastMaster, hideToast],
	);
}

// State-backed errors are announced once per transition, including StrictMode.
export function useToastMessage(message, severity = "error", enabled = true) {
	const notify = useAppToast();
	const previous = useRef("");
	useEffect(() => {
		if (!enabled) return;
		if (message && previous.current !== message) notify(message, severity);
		previous.current = message || "";
	}, [message, severity, enabled, notify]);
}
