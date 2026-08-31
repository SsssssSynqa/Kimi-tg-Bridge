import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseFlowCommand } = require('../src/group-flow.cjs');

test('flow commands parse without a workspace-external module', () => {
  assert.deepEqual(parseFlowCommand('/flow 20'), { action: 'set', limit: 20, asked: 20, clamped: false });
  assert.deepEqual(parseFlowCommand('/flow 99999'), { action: 'set', limit: 20, asked: 99999, clamped: true });
  assert.deepEqual(parseFlowCommand('/flow off'), { action: 'clear' });
  assert.deepEqual(parseFlowCommand('/flow'), { action: 'status' });
  assert.equal(parseFlowCommand('flow 20'), null);
});
