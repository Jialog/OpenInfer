import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { copyProject, discardProject, tests } from './mutations.mjs';

// A mutant counts as killed only when its tests fail because of the mutation, so in an unmutated copy the tests a mutant
// names must pass.
test('an unmutated project copy passes a test a mutant names', () => {
  const root = copyProject(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const result = tests(root, ['test/build.test.ts', '--test-name-pattern', 'another bridge revision']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-2000));
  } finally { discardProject(root); }
});
