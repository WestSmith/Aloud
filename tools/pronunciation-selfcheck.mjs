/* Contextual pronunciation, using the production normalizer and native mapper. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const section = (a,b) => { const start=source.indexOf(a),end=source.indexOf(b,start); assert(start>=0 && end>start, 'Missing production section: '+a); return source.slice(start,end); };
const S = {skipCode:true, dict:{}, words:[]};
const helpers = new Function('S',
  section('const BUILTIN_SPOKEN','/* ---- source citations') +
  section('function falseStop(', '/* relative timeline') +
  section('const ABBREV =', 'function restoreLegacyHtmlOffsets') +
  section('function splitSentences(', 'function resetDocState(') +
  section('function alignNativeTokenStarts(', 'function nativeKokoroError(') +
  '\nreturn {spokenFor,spokenTokens,spokenOfWord,splitSentences,buildFromTokenStream,falseStop,pauseAfterMs,alignNativeTokenStarts};'
)(S);

const cases = [
  [['Ms.','Smith'],['miz','Smith']],
  [['“Ms.','Smith,”'],['“miz','Smith,”']],
  [['(Ms.)'],['(miz)']],
  [['MS','MS.','ms','ms.'],['MS','MS.','ms','ms.']],
  [['10','ms.'],['10','ms.']],
  [['No.'],['No.']],
  [['No.','I','did','not.'],['No.','I','did','not.']],
  [['No','thanks.'],['No','thanks.']],
  [['Q.','Did','you?','A.','No.'],['Q.','Did','you?','A.','No.']],
  [['No.','12'],['number','12']],
  [['A:','No.','12','witnesses'],['A:','No.','12','witnesses']],
  [['A.','No.','12','witnesses'],['A.','No.','12','witnesses']],
  [['(No.','12)'],['(number','12)']],
  [['NO.','(12)'],['number','(12)']],
  [['“No.”','12'],['“No.”','12']],
  [['No.','I','agree.'],['No.','I','agree.']],
  [['No.','IV'],['No.','IV']],
  [['No.12'],['number twelve']],
  [['(No.105),'],['(number one hundred five),']],
];
for (const dict of [{}, {no:'Number'}, {'no.':'number.'}]) {
  S.dict=dict;
  for (const [input,expected] of cases) assert.deepEqual(helpers.spokenTokens(input),expected);
}
S.dict={no:'nah',aloud:'uh loud'};
assert.equal(helpers.spokenFor('No.'),'nah.','Explicit alternative override was lost');
assert.equal(helpers.spokenFor('Aloud,'),'uh loud,');
assert.equal(helpers.spokenFor('e.g.'),'for example,');
assert.equal(helpers.spokenFor('https://example.test'),'');
S.dict={ms:'miss'};
assert.equal(helpers.spokenFor('Ms.'),'miss.','Saved title pronunciation was overridden');
S.dict={no:'Number'};
assert.deepEqual(helpers.splitSentences('No. I did not.'),['No.','I did not.']);
assert.deepEqual(helpers.splitSentences('A: No. 12 witnesses testified.'),['A: No.','12 witnesses testified.']);
assert.deepEqual(helpers.splitSentences('File No. 12 is here.'),['File No. 12 is here.']);
assert.equal(helpers.pauseAfterMs('No.',false,'I'),330);
assert.equal(helpers.pauseAfterMs('No.',false,'12'),40);

const stream = (tokens,blocks) => {
  const target={words:[],sentences:[]};
  helpers.buildFromTokenStream(tokens,tokens.map(()=>null),blocks,null,target);
  S.words=target.words;
  return target.words.map(helpers.spokenOfWord);
};
assert.deepEqual(stream(['No.','12'],[0,1]),['No.','12'],'Reading crossed a block boundary');
assert.deepEqual(stream(['No.','12'],[0,0]),['number','12']);
S.words[1].mute=true;
assert.equal(helpers.spokenOfWord(S.words[0]),'No.','Reading used a skipped number');
assert.equal(helpers.spokenOfWord(S.words[1]),'');

// A chunk may finish at No.; alignment must use the very same resolved form
// generation used before splitting, rather than guessing again inside it.
const no = {text:'number',whitespace:' ',phonemes:'n',startSec:.2};
assert.deepEqual(helpers.alignNativeTokenStarts(['No.'],[no],1,['number']),[.2]);
assert.equal(helpers.alignNativeTokenStarts(['No.'],[no],1),null);
console.log('pronunciation self-check: PASS (titles, acronyms/units, answers, labels, saved rules, blocks, mutes, pauses and chunk alignment)');
