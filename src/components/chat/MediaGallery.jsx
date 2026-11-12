import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import MediaLightbox from "./MediaLightbox.jsx";

const MediaGalleryContext = createContext(null);

// Groups every media item rendered under one provider so the lightbox can
// navigate between them with the previous/next buttons.
export function MediaGalleryProvider({ children }) {
	const registry = useRef(new Map());
	const [viewer, setViewer] = useState(null);

	const register = useCallback((id, item) => {
		registry.current.set(id, item);
		return () => {
			registry.current.delete(id);
		};
	}, []);

	const open = useCallback((id) => {
		const items = [...registry.current.entries()].map(([key, item]) => ({ ...item, id: key }));
		const index = items.findIndex((item) => item.id === id);
		if (index < 0) return;
		setViewer({ items, index });
	}, []);
	const value = useMemo(() => ({ register, open }), [register, open]);

	return (
		<MediaGalleryContext.Provider value={value}>
			{children}
			{viewer && (
				<MediaLightbox
					items={viewer.items}
					index={viewer.index}
					onIndexChange={(index) => setViewer((current) => (current ? { ...current, index } : current))}
					onClose={() => setViewer(null)}
				/>
			)}
		</MediaGalleryContext.Provider>
	);
}

// Registers a media source for as long as the calling component is mounted.
// Returns null outside a gallery or when there is no source to open.
export function useRegisterMedia(item) {
	const gallery = useContext(MediaGalleryContext);
	const id = useId();
	const src = item?.src || "";
	const video = Boolean(item?.video);
	const title = item?.title || "";

	useEffect(() => {
		if (!gallery || !src) return undefined;
		return gallery.register(id, { src, video, title });
	}, [gallery, id, src, video, title]);

	return gallery && src ? { gallery, id } : null;
}
