import React, { useState, useEffect } from "react";
import { FiCode, FiFile, FiFileText, FiFilm, FiImage } from "react-icons/fi";
import { AttachmentControls } from "./AttachmentControls.jsx";
import { MediaGalleryProvider, useRegisterMedia } from "./MediaGallery.jsx";

function displayName(filePath) {
	return String(filePath ?? "")
		.split(/[\\/]/)
		.pop()
		.replace(/^\d+-[0-9a-f-]{36}-/i, "");
}

function kindOf(attachment) {
	const mime = String(attachment?.mime_type ?? "").toLowerCase();
	const path = String(attachment?.file_path ?? "").toLowerCase();
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m2ts|mts|mpeg|mpg|m4v|ogv|3gp|3g2|wmv|flv|vob)$/.test(path)) return "video";
	if (mime === "application/pdf" || path.endsWith(".pdf")) return "pdf";
	if (/text\/|json|csv|tab-separated|markdown|html|css|xml|javascript/.test(mime)) return "doc";
	if (/\.(txt|md|csv|tsv|json|js|mjs|cjs|jsx|ts|tsx|py|html|css|xml|yaml|yml|toml|ini|sh|sql|log|c|h|cpp|java|go|rs|rb|php)$/.test(path))
		return "code";
	return "file";
}

const KIND_ICON = {
	pdf: FiFileText,
	doc: FiFileText,
	code: FiCode,
	file: FiFile,
};

function AttachmentCard({ attachment }) {
	const [failed, setFailed] = useState(false);
	const kind = kindOf(attachment);
	const media = kind === "image" || kind === "video";
	const name = attachment.name || displayName(attachment?.file_path) || "Attachment";
	const [src,setSrc]=useState(''), [problem,setProblem]=useState('');
    useEffect(()=>{
        let active=true; setFailed(false); setSrc('');
        if(attachment.version_id && !attachment.omitted) window.api?.previewAttachment?.({sessionId:attachment.session_id,attachment:{id:attachment.id}}).then(result=>{if(active)setSrc(result.dataUrl || '');}).catch(error=>{if(active){setFailed(true);setProblem(error.message);}});
        return ()=>{active=false;};
    },[attachment.version_id,attachment.omitted]);
    const registration = useRegisterMedia(media && src && !failed ? { src, video: kind === "video", title: name } : null);
    const open = async () => {
        if (media) {
            if (registration) registration.gallery.open(registration.id);
            return;
        }
        try { await window.api?.openAttachment?.({sessionId:attachment.session_id,attachment:{id:attachment.id}}); }
        catch(error) { setProblem(error.message); }
    };

	return (
		<div className="w-44 shrink-0">
        <button
			type="button"
			title={`${name}\n${attachment?.file_path ?? ""}\n${media ? "Click to view" : "Click to open"}`}
			aria-label={`${media ? "View" : "Open"} attachment ${name}`}
			onClick={open}
			className="w-36 shrink-0 cursor-pointer overflow-hidden ui-radius-control border border-[var(--attachment-border)] bg-[var(--surface-raised)] text-left transition-colors hover:border-[var(--edit-border)]"
		>
			<span className="flex h-24 w-full items-center justify-center overflow-hidden bg-black/25">
				{kind === "image" && src && !failed ? (
					<img
						src={src}
						alt={name}
						loading="lazy"
						className="h-24 w-full cursor-zoom-in object-cover"
						onError={() => setFailed(true)}
					/>
				) : kind === "video" && src && !failed ? (
					<span className="relative flex h-24 w-full items-center justify-center">
						<video
							src={src}
							preload="metadata"
							muted
							playsInline
							className="h-24 w-full cursor-zoom-in object-cover"
							onError={() => setFailed(true)}
						/>
						<span
							aria-hidden="true"
							className="absolute flex size-8 items-center justify-center ui-radius-round bg-black/60 text-white"
						>
							<FiFilm size={15} />
						</span>
					</span>
				) : kind === "image" || kind === "video" ? (
					<FiImage
						size={26}
						aria-hidden="true"
						className="text-[var(--text-muted)]"
					/>
				) : (
					React.createElement(KIND_ICON[kind] ?? FiFile, {
						size: 26,
						"aria-hidden": true,
						className:
							kind === "pdf" ? "text-red-400" : "text-[var(--text-muted)]",
					})
				)}
			</span>
			<span className="block truncate px-2 pb-1 pt-1.5 text-[11px] font-medium text-[var(--text-primary)]">
				{name}
			</span>
			<span className="block px-2 pb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
				{kind === "image" ? "Image" : kind === "video" ? "Video" : kind === "pdf" ? "PDF" : "File"}
			</span>
		</button>
        <AttachmentControls attachment={attachment} />
        {problem && <p role="status" className="text-[11px] text-[var(--error)]">{problem}</p>}
        </div>
	);
}

export default function AttachmentPreview({ attachments }) {
	if (!attachments?.length) return null;
	return (
		<MediaGalleryProvider>
			<ul
				aria-label="Message attachments"
				className="flex flex-wrap gap-2 whitespace-normal"
			>
				{attachments.map((attachment) => (
					<li key={attachment.id || attachment.file_path}>
						<AttachmentCard attachment={attachment} />
					</li>
				))}
			</ul>
		</MediaGalleryProvider>
	);
}
