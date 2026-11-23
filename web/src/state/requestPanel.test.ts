import {describe, expect, it} from 'vitest';
import {makeRequest} from '@/test/factories';
import {
  emptyDraft,
  promptFileProblem,
  promptFileSize,
  initialPanel,
  panelReducer,
  validateDraft,
  type Draft,
  type PanelState,
} from './requestPanel';

const draft: Draft = {...emptyDraft, prompt: 'hello'};
const editing: PanelState = panelReducer(initialPanel, {type: 'edit', patch: {prompt: 'hello'}});
const submitting: PanelState = panelReducer(editing, {type: 'submit', key: 'key-1'});
const showing: PanelState = panelReducer(submitting, {type: 'created', requestId: 'r-1'});

// The request form.
describe('a prompt from a file', () => {
  const file = {id: 'file-1', name: 'task.md', size_bytes: 12};

  it('sends the uploaded file\'s id instead of a prompt, with a maximum output when given', () => {
    expect(validateDraft({...emptyDraft, file})).toEqual({ok: true, input: {prompt_file_id: 'file-1'}});
    expect(validateDraft({...emptyDraft, prompt: 'left in the box', file, maxOutput: '64'})).toEqual({ok: true, input: {prompt_file_id: 'file-1', max_output_tokens: 64}});
    expect(validateDraft({...emptyDraft, file, maxOutput: 'x'}).ok).toBe(false);
  });

  it('accepts a .txt or .md file of up to 64 KiB, and says what is wrong with another', () => {
    expect(promptFileProblem('notes.txt', 1)).toBeNull();
    expect(promptFileProblem('Notes.MD', 64 * 1024)).toBeNull();
    expect(promptFileProblem('slides.pdf', 10)).toBe('Choose a .txt or .md file.');
    expect(promptFileProblem('notes', 10)).toBe('Choose a .txt or .md file.');
    expect(promptFileProblem('notes.txt', 64 * 1024 + 1)).toBe('The file is over the 64 KiB limit.');
    expect(promptFileProblem('notes.txt', 0)).toBe('The file is empty.');
    expect([1, 1023, 1024, 64 * 1024].map(promptFileSize)).toEqual(['1 byte', '1023 bytes', '1.0 KiB', '64.0 KiB']);
  });
});

describe('validateDraft', () => {
  it('sends only the prompt by default', () => {
    expect(validateDraft(draft)).toEqual({ok: true, input: {prompt: 'hello'}});
  });

  it('rejects an empty prompt', () => {
    expect(validateDraft(emptyDraft).ok).toBe(false);
  });

  it('rejects a prompt over 64 KiB counted in UTF-8 bytes', () => {
    expect(validateDraft({...draft, prompt: 'x'.repeat(64 * 1024)}).ok).toBe(true);
    expect(validateDraft({...draft, prompt: 'é'.repeat(32 * 1024 + 1)}).ok).toBe(false);
  });

  it('sends max output only when given, and it must be a positive integer', () => {
    expect(validateDraft({...draft, maxOutput: '128'})).toEqual({ok: true, input: {prompt: 'hello', max_output_tokens: 128}});
    for (const bad of ['0', '-1', '1.5', 'abc']) expect(validateDraft({...draft, maxOutput: bad}).ok).toBe(false);
  });

  it('sends only the prompt id in acceptance mode, without max output', () => {
    expect(validateDraft({...draft, prompt: 'ignored', maxOutput: '5', acceptanceId: 'p1'})).toEqual({
      ok: true, input: {acceptance_prompt_id: 'p1'},
    });
  });
});

describe('request panel', () => {
  it('editing + valid submit -> submitting', () => {
    expect(submitting).toMatchObject({phase: 'submitting', key: 'key-1', uncertain: false});
  });

  it('editing + invalid submit -> editing with a message', () => {
    const next = panelReducer(initialPanel, {type: 'submit', key: 'k'});
    expect(next.phase).toBe('editing');
    expect((next as {error: string}).error).toMatch(/prompt/i);
  });

  it('submitting + request id -> showing', () => {
    expect(showing).toMatchObject({phase: 'showing', requestId: 'r-1'});
  });

  it('409 busy -> editing, with the draft kept', () => {
    const next = panelReducer(submitting, {type: 'busy', message: 'A request is running.'});
    expect(next).toMatchObject({phase: 'editing', error: 'A request is running.'});
    expect(next.draft.prompt).toBe('hello');
  });

  it('other rejection -> editing with the reason', () => {
    const next = panelReducer(submitting, {type: 'rejected', message: 'Too long.'});
    expect(next).toMatchObject({phase: 'editing', error: 'Too long.'});
  });

  it('timeout keeps the key; retry resubmits with it', () => {
    const uncertain = panelReducer(submitting, {type: 'timeout'});
    expect(uncertain).toMatchObject({phase: 'submitting', uncertain: true, key: 'key-1'});
    expect(panelReducer(uncertain, {type: 'retry'})).toMatchObject({phase: 'submitting', uncertain: false, key: 'key-1'});
  });

  it('going back after a timeout reuses the key if the text is unchanged', () => {
    const back = panelReducer(panelReducer(submitting, {type: 'timeout'}), {type: 'back_to_edit'});
    expect(back.phase).toBe('editing');
    expect(panelReducer(back, {type: 'submit', key: 'key-2'})).toMatchObject({key: 'key-1'});
  });

  it('editing the text drops the key', () => {
    const back = panelReducer(panelReducer(submitting, {type: 'timeout'}), {type: 'back_to_edit'});
    const edited = panelReducer(back, {type: 'edit', patch: {prompt: 'changed'}});
    expect(panelReducer(edited, {type: 'submit', key: 'key-2'})).toMatchObject({key: 'key-2'});
  });

  it('showing + terminal request but incomplete output -> still showing', () => {
    const next = panelReducer(showing, {type: 'observe', request: makeRequest({id: 'r-1', state: 'completed'}), complete: false});
    expect(next.phase).toBe('showing');
  });

  it('showing + terminal request and complete output -> terminal', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      const next = panelReducer(showing, {type: 'observe', request: makeRequest({id: 'r-1', state}), complete: true});
      expect(next).toMatchObject({phase: 'terminal', requestId: 'r-1'});
    }
  });

  it('showing + a non-terminal update -> still showing', () => {
    expect(panelReducer(showing, {type: 'observe', request: makeRequest({id: 'r-1', state: 'running'}), complete: false}).phase).toBe('showing');
  });

  it('ignores an update for another request', () => {
    expect(panelReducer(showing, {type: 'observe', request: makeRequest({id: 'other', state: 'completed'}), complete: true}).phase).toBe('showing');
  });

  it('terminal + new request -> editing with a cleared form', () => {
    const terminal = panelReducer(showing, {type: 'observe', request: makeRequest({id: 'r-1', state: 'completed'}), complete: true});
    const next = panelReducer(terminal, {type: 'new_request'});
    expect(next).toEqual(initialPanel);
  });

  it('resumes showing an existing request after a refresh', () => {
    expect(panelReducer(initialPanel, {type: 'resume', requestId: 'r-9'})).toMatchObject({phase: 'showing', requestId: 'r-9'});
  });

  it('does not resume over a submission in progress', () => {
    expect(panelReducer(submitting, {type: 'resume', requestId: 'r-9'})).toEqual(submitting);
  });
});
