import React, { useEffect, useRef } from "react";
import { FiChevronLeft, FiChevronRight, FiX } from "react-icons/fi";

// Full-screen media viewer used by rich cards. A native <dialog> keeps the
// rest of the chat inert and gives Escape/focus handling for free.
export default function MediaLightbox({ items, index, onIndexChange, onClose }) {
	const dialogRef = useRef(null);
	const item = items[index];

	useEffect(() => {
		const element = dialogRef.current;
		if (element && !element.open) {
			try {
				element.showModal();
			} catch {
				/* Already open or unsupported; content still renders. */
			}
		}
		return () => {
			if (element?.open) element.close();
		};
	}, []);

	if (!item) return null;

	const multiple = items.length > 1;
	const move = (delta) => {
		if (!multiple) return;
		onIndexChange((index + delta + items.length) % items.length);
	};
	const label = item.title || (item.video ? "Video" : "Image");

	return (
		<dialog
			ref={dialogRef}
			aria-label={`Media viewer: ${label}`}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target === dialogRef.current) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					move(-1);
				} else if (event.key === "ArrowRight") {
					event.preventDefault();
					move(1);
				}
			}}
			className="media-lightbox"
		>
			<div className="media-lightbox-shell">
				<header className="media-lightbox-header">
					<span className="media-lightbox-title">{label}</span>
					<span className="media-lightbox-count">
						{index + 1} / {items.length}
					</span>
					<button
						type="button"
						className="media-lightbox-close"
						aria-label="Close media viewer"
						onClick={onClose}
						autoFocus
					>
						<FiX aria-hidden="true" />
					</button>
				</header>
				<div className="media-lightbox-stage">
					<button
						type="button"
						className="media-lightbox-nav media-lightbox-prev"
						aria-label="Previous media"
						disabled={!multiple}
						onClick={() => move(-1)}
					>
						<FiChevronLeft aria-hidden="true" />
					</button>
					{item.video ? (
						<video
							key={item.src}
							src={item.src}
							controls
							playsInline
							preload="metadata"
							aria-label={label}
							className="media-lightbox-media"
						/>
					) : (
						<img
							key={item.src}
							src={item.src}
							alt={label}
							className="media-lightbox-media"
						/>
					)}
					<button
						type="button"
						className="media-lightbox-nav media-lightbox-next"
						aria-label="Next media"
						disabled={!multiple}
						onClick={() => move(1)}
					>
						<FiChevronRight aria-hidden="true" />
					</button>
				</div>
			</div>
		</dialog>
	);
}
