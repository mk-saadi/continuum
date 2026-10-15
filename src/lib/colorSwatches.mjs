// Inline color swatches for chat markdown: detect CSS color literals in
// assistant prose and render a 1em preview block beside each one.
// Pure module (no DOM/React) so unit tests run under plain node.

const HEX = "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])";

// 0-255 channel or 0-100% channel; alpha is 0-1 or 0-100%.
const CHANNEL = "\\d{1,3}(?:\\.\\d+)?%?";
const ALPHA = "\\d{1,3}(?:\\.\\d+)?%?";
const HUE = "-?\\d{1,3}(?:\\.\\d+)?(?:deg|rad|grad|turn)?";
const PCT = "\\d{1,3}(?:\\.\\d+)?%";

const RGB_COMMA = `rgba?\\(\\s*${CHANNEL}\\s*,\\s*${CHANNEL}\\s*,\\s*${CHANNEL}\\s*(?:,\\s*${ALPHA}\\s*)?\\)`;
const RGB_SPACE = `rgba?\\(\\s*${CHANNEL}(?:\\s+${CHANNEL}){2}\\s*(?:\\/\\s*${ALPHA}\\s*)?\\)`;
const HSL_COMMA = `hsla?\\(\\s*${HUE}\\s*,\\s*${PCT}\\s*,\\s*${PCT}\\s*(?:,\\s*${ALPHA}\\s*)?\\)`;
const HSL_SPACE = `hsla?\\(\\s*${HUE}\\s+${PCT}\\s+${PCT}\\s*(?:\\/\\s*${ALPHA}\\s*)?\\)`;

// Leading lookbehind keeps C# references, URL fragments (#abc after a word
// char), and ## sequences from matching as hex colors.
export const COLOR_PATTERN = new RegExp(
  `(?<![0-9A-Za-z#])(${HEX}|${RGB_COMMA}|${RGB_SPACE}|${HSL_COMMA}|${HSL_SPACE})`,
  "gi",
);

function inRange(raw, min, max) {
  if (!/^-?\d+(?:\.\d+)?%?$/.test(raw)) return false;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= min && value <= max;
}

function isChannel(raw) {
  return raw.endsWith("%") ? inRange(raw, 0, 100) : inRange(raw, 0, 255);
}

function isAlpha(raw) {
  return raw.endsWith("%") ? inRange(raw, 0, 100) : inRange(raw, 0, 1);
}

// Range-check a regex match. The pattern already enforces shape; this rejects
// out-of-range values such as rgb(999, 0, 0). Hue wraps per CSS so any finite
// hue is accepted; saturation/lightness must be percentages.
export function isValidColor(value) {
  if (typeof value !== "string" || !value) return false;
  if (value[0] === "#") {
    return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
  }
  const match = /^(rgba?|hsla?)\(\s*([\s\S]*?)\s*\)$/i.exec(value);
  if (!match) return false;
  const family = match[1].toLowerCase();
  const inner = match[2];
  let parts;
  if (inner.includes(",")) {
    parts = inner.split(",").map((part) => part.trim());
    if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part)) return false;
  } else {
    const [colorPart, alphaPart] = inner.split("/").map((part) => part.trim());
    const channels = colorPart.split(/\s+/).filter(Boolean);
    if (channels.length !== 3) return false;
    parts = alphaPart ? [...channels, alphaPart] : channels;
  }
  const isRgb = family.startsWith("rgb");
  const channels = parts.slice(0, 3);
  const alpha = parts[3];
  if (isRgb) {
    if (!channels.every(isChannel)) return false;
  } else {
    const [hue, saturation, lightness] = channels;
    if (!/^-?\d+(?:\.\d+)?(?:deg|rad|grad|turn)?$/i.test(hue) || !Number.isFinite(Number.parseFloat(hue))) return false;
    if (!saturation.endsWith("%") || !lightness.endsWith("%")) return false;
    if (!inRange(saturation, 0, 100) || !inRange(lightness, 0, 100)) return false;
  }
  if (alpha !== undefined && !isAlpha(alpha)) return false;
  return true;
}

// Split plain text into [{ text }, { color }] segments. Only range-valid
// colors become swatches; everything else stays plain text.
export function splitTextWithColors(text) {
  if (typeof text !== "string" || !text) return [];
  const segments = [];
  let last = 0;
  COLOR_PATTERN.lastIndex = 0;
  let found;
  while ((found = COLOR_PATTERN.exec(text)) !== null) {
    const color = found[1];
    if (!isValidColor(color)) continue;
    if (found.index > last) segments.push({ text: text.slice(last, found.index) });
    segments.push({ color });
    last = found.index + color.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
