// Model output split into plain text and fenced code blocks. Nothing is interpreted as markup: both kinds are
// shown as text, code in a monospace block. A block whose closing fence has not arrived yet is still code.
export type OutputPart = {kind: 'text'; text: string} | {kind: 'code'; text: string; language: string | null; closed: boolean};

const OPEN = /^ {0,3}```([^`]*)$/;
const CLOSE = /^ {0,3}```\s*$/;

export function splitOutput(text: string): OutputPart[] {
  const parts: OutputPart[] = [];
  let buffer: string[] = [];
  let code: {language: string | null} | null = null;

  const flush = (closed: boolean) => {
    const joined = buffer.join('\n');
    buffer = [];
    if (code) parts.push({kind: 'code', text: joined, language: code.language, closed});
    else if (joined) parts.push({kind: 'text', text: joined});
  };

  for (const line of text.split('\n')) {
    if (!code) {
      const open = OPEN.exec(line);
      if (open) {
        flush(false);
        code = {language: open[1].trim() || null};
        continue;
      }
    } else if (CLOSE.test(line)) {
      flush(true);
      code = null;
      continue;
    }
    buffer.push(line);
  }
  flush(false);
  return parts;
}
