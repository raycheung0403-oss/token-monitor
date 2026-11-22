'use strict';

// Qoder does not expose raw token fields locally. Assistant content is the only
// output-side evidence, so count it with a deliberately conservative heuristic:
// CJK roughly one token per character, ASCII/code roughly 3.7 characters per
// token. The result is an estimate, not a tokenizer.
function isCjkCodePoint(cp) {
  return (cp >= 0x2E80 && cp <= 0x9FFF)
    || (cp >= 0xAC00 && cp <= 0xD7AF)
    || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0xFE30 && cp <= 0xFE4F)
    || (cp >= 0xFF00 && cp <= 0xFFEF)
    || (cp >= 0x20000 && cp <= 0x2FA1F);
}

function estimateTextTokens(text) {
  let cjk = 0;
  let ascii = 0;
  let space = 0;
  let other = 0;
  for (const char of String(text || '')) {
    const cp = char.codePointAt(0);
    if (isCjkCodePoint(cp)) cjk += 1;
    else if (/\s/.test(char)) space += 1;
    else if (cp < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.05 + ascii / 3.7 + other * 0.8 + space / 8);
}

function estimateJsonTokens(value) {
  if (value === undefined) return 0;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_) {
    text = String(value);
  }
  return estimateTextTokens(text);
}

function estimateBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0;
  if (block.type === 'text') return 4 + estimateTextTokens(block.text);
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    return 4 + estimateTextTokens(block.thinking || block.data || '');
  }
  if (block.type === 'tool_use' || block.type === 'server_tool_use') {
    return 12 + estimateTextTokens(block.name || '') + estimateJsonTokens(block.input);
  }
  return 8 + estimateJsonTokens(block);
}

function estimateContentTokens(content) {
  let total = 0;
  for (const block of Array.isArray(content) ? content : []) total += estimateBlockTokens(block);
  return total;
}

function estimateThinkingTokens(content) {
  let total = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      total += estimateBlockTokens(block);
    }
  }
  return total;
}

module.exports = {
  estimateBlockTokens,
  estimateContentTokens,
  estimateJsonTokens,
  estimateTextTokens,
  estimateThinkingTokens
};
