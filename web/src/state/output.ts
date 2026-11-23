// Streamed output for one request. Only the gap-free prefix is displayed; chunks are deduplicated by seq.
// Thinking and answer are held apart by each chunk's segment; a chunk recorded before segments existed (null)
// goes with the answer, so old output reads as one text, as it always did.
import type {Chunk, RequestState, RequestSummary} from '@/api/types';

export type OutputState = {
  think: string;
  thinkTokens: number;
  answer: string;
  /** White space before the answer has started that may be its first line's indentation. */
  held: string;
  contiguous: number;
  pending: Record<number, Chunk>;
};

export const emptyOutput: OutputState = {think: '', thinkTokens: 0, answer: '', held: '', contiguous: 0, pending: {}};

// The blank lines the model writes after the thinking are not part of the answer; the indentation of its first
// line is. The same rule as the /v1 content (server/src/openai.ts).
const BLANK_LINES = /^(?:[ \t]*\r?\n)+/;
const INDENT_ONLY = /^[ \t]*$/;

const TERMINAL_REQUEST: ReadonlySet<RequestState> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalRequest(state: RequestState): boolean {
  return TERMINAL_REQUEST.has(state);
}

export function applyChunks(state: OutputState, chunks: Chunk[]): OutputState {
  let {think, thinkTokens, answer, held, contiguous} = state;
  const pending = {...state.pending};
  for (const chunk of chunks) {
    const seq = Number(chunk.seq);
    if (seq > contiguous) pending[seq] = chunk;
  }
  while (pending[contiguous + 1]) {
    contiguous += 1;
    const chunk = pending[contiguous];
    if (chunk.segment === 'think') {
      think += chunk.text;
      thinkTokens += chunk.token_count;
    } else if (answer !== '') {
      answer += chunk.text;
    } else {
      // Not started yet: blank lines go at their newline; possible indentation waits for its line's first other character.
      held = (held + chunk.text).replace(BLANK_LINES, '');
      if (!INDENT_ONLY.test(held)) {
        answer = held;
        held = '';
      }
    }
    delete pending[contiguous];
  }
  return {think, thinkTokens, answer, held, contiguous, pending};
}

/** The request has ended and every chunk the server holds for it is here. */
export function isOutputComplete(request: RequestSummary, output: OutputState): boolean {
  return isTerminalRequest(request.state) && output.contiguous >= Number(request.contiguous_seq);
}
