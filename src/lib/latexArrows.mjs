// Normalize common LaTeX arrow/symbol commands to Unicode so chat markdown
// never shows raw "$\rightarrow$" text. The renderer (ReactMarkdown +
// remark-gfm) has no math plugin, so math delimiters would otherwise leak.
// Code fences (``` blocks) and inline `code` are left untouched.

const COMMANDS = {
  to: "→",
  rightarrow: "→",
  longrightarrow: "⟶",
  leftarrow: "←",
  gets: "←",
  longleftarrow: "⟵",
  Leftrightarrow: "⇔",
  Longleftrightarrow: "⇔",
  leftrightarrow: "↔",
  longleftrightarrow: "⟷",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  uparrow: "↑",
  downarrow: "↓",
  updownarrow: "↕",
  nearrow: "↗",
  searrow: "↘",
  swarrow: "↙",
  nwarrow: "↖",
  times: "×",
  cdot: "·",
  pm: "±",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  infty: "∞",
};

const NAMES = Object.keys(COMMANDS).sort((a, b) => b.length - a.length).join("|");
const BARE_COMMAND = new RegExp(`\\\\(${NAMES})(?![A-Za-z])`, "g");
// Lone dollars wrapping only an arrow/symbol (e.g. "$→$" left after the
// command swap, or a model that emitted the Unicode char inside $...$).
const WRAPPED_ARROW = new RegExp(`\\$\\$?\\s*([→←⇒⇐↔⟶⟵⟷⇔↑↓↕↗↘↙↖×·±≤≥≠≈∞])\\s*\\$\\$?`, "g");

function replaceOutsideInlineCode(segment) {
  // Split on `...` inline code, keeping delimiters; replace only outside them.
  let inCode = false;
  return segment
    .split(/(`+)/g)
    .map((part) => {
      if (/^`+$/.test(part)) {
        inCode = !inCode;
        return part;
      }
      if (inCode) return part;
      return part.replace(BARE_COMMAND, (_, name) => COMMANDS[name]).replace(WRAPPED_ARROW, "$1");
    })
    .join("");
}

export function normalizeLatexArrows(text) {
  if (typeof text !== "string" || !text.includes("\\") && !text.includes("$")) return text;
  // Split on ``` fenced blocks, keeping delimiters; touch only even parts.
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => (index % 2 === 1 ? part : replaceOutsideInlineCode(part)))
    .join("");
}
