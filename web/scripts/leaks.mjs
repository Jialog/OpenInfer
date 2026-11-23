// What must not appear in the visible text of a page: internal labels, backend codes,
// absolute paths and the raw device probe. The screenshot script runs it on every shot.
const PATTERNS = [
  /\b[tp]\d+\b/i,                      // numbered internal labels: t4, T10, P12
  /\/(opt|home|Users|usr)\//,          // absolute paths
  /not installed in|sglang|ngram/i,   // raw engine probe
  /Check [a-z ]+ passed\./i,           // the backend's default check message
  // Backend codes are lowercase words joined by underscores (direction_unreachable). Upper-case quantisation
  // names such as UD-Q3_K_XL are product names and pass.
  /\b[a-z]+_[a-z_]+\b/,
];

/** The first piece of internal text in `text`, or null. */
export function findLeak(text) {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/** The text of `root` the check reads, without the elements marked `data-leak-exempt`: code blocks that show API field
 *  names on purpose (the API keys page). They are taken out for the read and put back. Self-contained, so the screenshot
 *  script can run it in the page, where innerText follows the layout (a closed Details section is left out); jsdom has
 *  no innerText and gives textContent. */
export function checkedText(root) {
  const marks = [...root.querySelectorAll('[data-leak-exempt]')].map((element) => {
    const mark = root.ownerDocument.createComment('');
    element.replaceWith(mark);
    return [element, mark];
  });
  try {
    return root.innerText ?? root.textContent;
  } finally {
    for (const [element, mark] of marks.reverse()) mark.replaceWith(element);
  }
}
