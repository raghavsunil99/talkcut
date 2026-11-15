// Word error rate for the speech-to-text benchmark.
// Words are split on whitespace and run through the editor's own normalize(), which keeps
// combining marks, so Telugu, Tamil, Malayalam, Kannada and Hindi vowel signs survive.
const { normalize } = require('../../src/renderer/edits.js');

function words(text) {
  return String(text ?? '').split(/\s+/).map(normalize).filter(Boolean);
}

// Word-level Levenshtein distance (substitutions, insertions and deletions each cost 1).
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// { errors, total } for one clip, so clips can be summed before dividing.
function wordErrors(reference, hypothesis) {
  const ref = words(reference);
  return { errors: editDistance(ref, words(hypothesis)), total: ref.length };
}

// Corpus WER: total errors over total reference words (not a mean of per-clip rates).
function wer(pairs) {
  let errors = 0;
  let total = 0;
  for (const [reference, hypothesis] of pairs) {
    const r = wordErrors(reference, hypothesis);
    errors += r.errors;
    total += r.total;
  }
  return total ? errors / total : null;
}

module.exports = { words, editDistance, wordErrors, wer };
