const test = require('node:test');
const assert = require('node:assert/strict');

const { mapWithConcurrency } = require('../src/async-utils.js');

test('mapWithConcurrency preserves result order and respects the concurrency limit', async () => {
  let activeCount = 0;
  let maxActiveCount = 0;

  const result = await mapWithConcurrency([40, 10, 30, 5], 2, async (delay, index) => {
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    await new Promise(resolve => setTimeout(resolve, delay));
    activeCount -= 1;
    return `task-${index}`;
  });

  assert.deepEqual(result, ['task-0', 'task-1', 'task-2', 'task-3']);
  assert.equal(maxActiveCount, 2);
});
