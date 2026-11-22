'use strict';

const assert = require('node:assert/strict');
const {
  estimateBlockTokens,
  estimateContentTokens,
  estimateJsonTokens,
  estimateTextTokens,
  estimateThinkingTokens
} = require('../src/estimate');

assert.equal(estimateTextTokens(''), 0);
assert.equal(estimateTextTokens(undefined), 0);
assert.equal(estimateTextTokens('hello world'), Math.ceil(10 / 3.7 + 1 / 8));
assert.ok(estimateTextTokens('你好世界') >= 4);
assert.ok(estimateTextTokens('你好世界') < estimateTextTokens('你好世界你好世界'));
assert.ok(estimateTextTokens('abc') > 0);
assert.equal(estimateJsonTokens(undefined), 0);
assert.ok(estimateJsonTokens({ command: 'npm test' }) > 0);

const textBlock = { type: 'text', text: 'done' };
const thinkingBlock = { type: 'thinking', thinking: 'let me check' };
const toolBlock = { type: 'tool_use', name: 'read_file', input: { path: 'a.js' } };

assert.ok(estimateBlockTokens(textBlock) >= 4);
assert.ok(estimateBlockTokens(toolBlock) > estimateBlockTokens(textBlock));
assert.equal(estimateBlockTokens(null), 0);
assert.equal(estimateBlockTokens({ type: 'unknown' }) > 0, true);
assert.equal(
  estimateContentTokens([textBlock, toolBlock]),
  estimateBlockTokens(textBlock) + estimateBlockTokens(toolBlock)
);
assert.equal(estimateContentTokens('not-an-array'), 0);
assert.equal(
  estimateThinkingTokens([textBlock, thinkingBlock]),
  estimateBlockTokens(thinkingBlock)
);
assert.equal(estimateThinkingTokens([thinkingBlock, { type: 'redacted_thinking', data: 'xx' }]) > 0, true);

process.stdout.write('estimate tests passed\n');
