// A few recent sentences/paragraphs, independent of response or context length.
const WINDOW_CHARACTERS = 1536;
const MIN_BLOCK_CHARACTERS = 50;

export function createRepetitionDetector() {
  let recent = '', significantCharacters = 0;
  return {
    // Inspect every character so a large SSE delta cannot hide a loop in its middle.
    push(delta) {
      for (let index = 0; index < delta.length; index++) {
        const extended = recent + delta[index];
        if (/[\p{L}\p{N}]$/u.test(extended.slice(-2))) significantCharacters++;
        if (recent.length === WINDOW_CHARACTERS && /^[\p{L}\p{N}]/u.test(recent.slice(0, 2))) significantCharacters--;
        recent = extended.slice(-WINDOW_CHARACTERS);
        // Skip expensive comparisons for long runs of whitespace/punctuation.
        if (significantCharacters < 60) continue;
        const end = recent.length;
        for (let size = MIN_BLOCK_CHARACTERS; size <= Math.floor(end / 3); size++) {
          if (recent[end - 1] !== recent[end - size - 1] || recent[end - 1] !== recent[end - 2 * size - 1]) continue;
          const block = recent.slice(end - size);
          if (block !== recent.slice(end - 2 * size, end - size) || block !== recent.slice(end - 3 * size, end - 2 * size)) continue;
          // Whitespace and Markdown/table separators are not reasoning paragraphs.
          if ((block.match(/[\p{L}\p{N}]/gu) || []).length < 20) continue;
          return { detected: true, text: delta.slice(0, index + 1) };
        }
      }
      return { detected: false, text: delta };
    },
  };
}
