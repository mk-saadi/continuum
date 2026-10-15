import React from "react";
import { splitTextWithColors } from "../lib/colorSwatches.mjs";

export function ColorSwatch({ value }) {
	return (
		<span
			className="inline-color-swatch"
			style={{ backgroundColor: value }}
			role="img"
			aria-label={`Color preview: ${value}`}
			title={value}
		/>
	);
}

// Inline elements whose children are safe to scan. Fenced code blocks are
// excluded (they render through CodeBlock, never here), but inline `code`
// IS scanned — agents list palette values as `#HEX` literals and those
// should preview too. Links are never scanned so URL fragments stay clean.
// Only string-typed elements are recursed into, so custom markdown
// components (a, pre) are left untouched.
const SCAN_TYPES = new Set([
	"strong",
	"em",
	"del",
	"s",
	"b",
	"i",
	"u",
	"span",
	"sub",
	"sup",
	"mark",
	"small",
]);

export function withColorSwatches(children) {
	return React.Children.map(children, (child) => {
		if (typeof child === "string") {
			const segments = splitTextWithColors(child);
			if (segments.length === 0) return child;
			if (segments.length === 1 && segments[0].text !== undefined) return child;
			return segments.map((segment, index) =>
				segment.color !== undefined ? (
					// Keep the literal text so the value stays readable (and
					// copyable); the swatch is a preview beside it.
					<React.Fragment key={`swatch-${index}`}>
						{segment.color}
						<ColorSwatch value={segment.color} />
					</React.Fragment>
				) : (
					<React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>
				),
			);
		}
		if (
			React.isValidElement(child) &&
			typeof child.type === "string" &&
			SCAN_TYPES.has(child.type) &&
			child.props?.children
		) {
			return React.cloneElement(child, { children: withColorSwatches(child.props.children) });
		}
		return child;
	});
}

// Block-level text container (p, li, h1-h3, td, th) that decorates color
// literals with swatches. Drops `node` (the mdast node) so it never reaches
// the DOM.
export function textBlock(Tag) {
	return function TextBlock({ node, children, ...props }) {
		return <Tag {...props}>{withColorSwatches(children)}</Tag>;
	};
}
