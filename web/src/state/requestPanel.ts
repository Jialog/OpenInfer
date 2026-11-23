// The request form. Its input rules are those of the server (docs/API.md).
import type {ID, PromptFile, RequestInput, RequestSummary} from '@/api/types';
import {isTerminalRequest} from './output';

export type Draft = {
  prompt: string;
  maxOutput: string;
  acceptanceId: string | null;
  /** An uploaded file to take the prompt from, instead of the typed prompt. */
  file: PromptFile | null;
};

export const emptyDraft: Draft = {prompt: '', maxOutput: '', acceptanceId: null, file: null};

export type PanelState =
  | {phase: 'editing'; draft: Draft; error: string | null; key: string | null}
  | {phase: 'submitting'; draft: Draft; key: string; uncertain: boolean}
  | {phase: 'showing'; draft: Draft; requestId: ID}
  | {phase: 'terminal'; draft: Draft; requestId: ID};

export type PanelEvent =
  | {type: 'edit'; patch: Partial<Draft>}
  | {type: 'submit'; key: string}
  | {type: 'created'; requestId: ID}
  | {type: 'busy'; message: string}
  | {type: 'rejected'; message: string}
  | {type: 'timeout'}
  | {type: 'retry'}
  | {type: 'back_to_edit'}
  | {type: 'observe'; request: RequestSummary; complete: boolean}
  | {type: 'resume'; requestId: ID}
  | {type: 'new_request'};

export const initialPanel: PanelState = {phase: 'editing', draft: emptyDraft, error: null, key: null};

const MAX_PROMPT_BYTES = 64 * 1024;

export function validateDraft(draft: Draft): {ok: true; input: RequestInput} | {ok: false; error: string} {
  if (draft.acceptanceId) {
    return {ok: true, input: {acceptance_prompt_id: draft.acceptanceId}};
  }
  if (!draft.file) {
    if (!draft.prompt.trim()) return {ok: false, error: 'Enter a prompt.'};
    if (new TextEncoder().encode(draft.prompt).length > MAX_PROMPT_BYTES) {
      return {ok: false, error: 'The prompt is over the 64 KiB limit.'};
    }
  }
  const input: RequestInput = draft.file ? {prompt_file_id: draft.file.id} : {prompt: draft.prompt};
  if (draft.maxOutput !== '') {
    if (!/^[1-9]\d*$/.test(draft.maxOutput)) return {ok: false, error: 'Maximum output must be a positive whole number.'};
    input.max_output_tokens = Number(draft.maxOutput);
  }
  return {ok: true, input};
}

/** Why a file cannot be uploaded as a prompt, or null: the server takes a .txt or .md file of 1 byte to 64 KiB. */
export function promptFileProblem(name: string, size: number): string | null {
  if (!/\.(txt|md)$/i.test(name)) return 'Choose a .txt or .md file.';
  if (size === 0) return 'The file is empty.';
  return size > MAX_PROMPT_BYTES ? 'The file is over the 64 KiB limit.' : null;
}

/** The size of a prompt file as the page shows it. */
export function promptFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function panelReducer(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case 'edit':
      if (state.phase !== 'editing') return state;
      return {...state, draft: {...state.draft, ...event.patch}, error: null, key: null};
    case 'submit': {
      if (state.phase !== 'editing') return state;
      const checked = validateDraft(state.draft);
      if (!checked.ok) return {...state, error: checked.error};
      return {phase: 'submitting', draft: state.draft, key: state.key ?? event.key, uncertain: false};
    }
    case 'created':
      return state.phase === 'submitting' ? {phase: 'showing', draft: state.draft, requestId: event.requestId} : state;
    case 'busy':
    case 'rejected':
      return state.phase === 'submitting'
        ? {phase: 'editing', draft: state.draft, error: event.message, key: null}
        : state;
    case 'timeout':
      return state.phase === 'submitting' ? {...state, uncertain: true} : state;
    case 'retry':
      return state.phase === 'submitting' ? {...state, uncertain: false} : state;
    case 'back_to_edit':
      return state.phase === 'submitting' ? {phase: 'editing', draft: state.draft, error: null, key: state.key} : state;
    case 'observe':
      if (state.phase !== 'showing' || event.request.id !== state.requestId) return state;
      return isTerminalRequest(event.request.state) && event.complete
        ? {phase: 'terminal', draft: state.draft, requestId: state.requestId}
        : state;
    case 'resume':
      return state.phase === 'editing' ? {phase: 'showing', draft: state.draft, requestId: event.requestId} : state;
    case 'new_request':
      return initialPanel;
  }
}
