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
  [['Mr.','Smith','Mrs.','Jones','Dr.','Brown'],['Mr.','Smith','Mrs.','Jones','Dr.','Brown']],
  [['Prof.','Smith','and','Hon.','Jones'],['professor','Smith','and','honourable','Jones']],
  [['Rt.','Hon.','Smith','met','Rev.','Brown.'],['right','honourable','Smith','met','reverend','Brown.']],
  [['Smith,','Jr.,','Jones,','Sr.','and','Brown,','Esq.'],['Smith,','junior,','Jones,','senior','and','Brown,','esquire']],
  [['“Prof.','Smith”'],['“professor','Smith”']],
  [['Prof.','of','Law','Rev.','ed.','Hon.','B.A.'],['Prof.','of','Law','Rev.','ed.','Hon.','B.A.']],
  [['Rev.','Ed.'],['Rev.','Ed.']],
  [['PROF.','HON.','REV.','JR.','SR.','ESQ.'],['PROF.','HON.','REV.','JR.','SR.','ESQ.']],
  [['Jr.','Smith','St.','James','10','ms.','30','s.','5'],['Jr.','Smith','St.','James','10','ms.','30','s.','5']],
  [['s.','5','and','ss.','7–9'],['section','5','and','sections','7–9']],
  [['See','p.','12','and','pp.','15–20'],['See','page','12','and','pages','15–20']],
  [['para.','12','paras.','14–16','cl.','2','cls.','3–4'],['paragraph','12','paragraphs','14–16','clause','2','clauses','3–4']],
  [['r.','7','rr.','8–9','Reg.','12','Regs.','13–14'],['rule','7','rules','8–9','regulation','12','regulations','13–14']],
  [['Sec.','5','and','secs.','6–7','Art.','8','arts.','9–10'],['section','5','and','sections','6–7','article','8','articles','9–10']],
  [['Sched.','A','Sch.','2','Vol.','3','Ch.','4'],['schedule','A','schedule','2','volume','3','chapter','4']],
  [['O.Reg.','194/90'],['Ontario regulation','194/90']],
  [['(s.5),','r.7.01(2)','para.12.'],['(section five),','rule seven point zero one two','paragraph twelve.']],
  [['S.','5','P.','12','R.','7','REG.','3','SEC.','4'],['S.','5','P.','12','R.','7','REG.','3','SEC.','4']],
  [['s.','Smith','Reg.','is','ready','s.1234567890'],['s.','Smith','Reg.','is','ready','s.1234567890']],
  [['“s.”','5'],['“s.”','5']],
  [['R.','v.','Smith','and','Brown','v.','Jones'],['R.','versus','Smith','and','Brown','versus','Jones']],
  [['(v.)','Brown','V.','Jones','x','v.','y'],['(v.)','Brown','V.','Jones','x','v.','y']],
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
S.dict={prof:'teacher','r.7.01(2)':'my rule',v:'against'};
assert.equal(helpers.spokenFor('Prof.','Smith'),'teacher.');
assert.equal(helpers.spokenFor('r.7.01(2)'),'my rule');
assert.equal(helpers.spokenFor('v.','Jones','Smith'),'against.');
S.dict={no:'Number'};
assert.deepEqual(helpers.splitSentences('Under r. 7 and cls. 2–3, Rev. Smith testified.'),['Under r. 7 and cls. 2–3, Rev. Smith testified.']);
assert.equal(helpers.pauseAfterMs('r.',false,'7'),40);
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

for (const [label,following] of [['s.','5'],['Prof.','Smith'],['v.','Jones']]) {
  stream(['Brown',label,following],[0,0,1]);
  assert.equal(helpers.spokenOfWord(S.words[1]),label,'Abbreviation crossed a block: '+label);
  stream(['Brown',label,following],[0,0,0]);
  S.words[2].mute=true;
  assert.equal(helpers.spokenOfWord(S.words[1]),label,'Abbreviation used skipped text: '+label);
}

stream(['Smith','Jr.'],[0,1]);
assert.equal(helpers.spokenOfWord(S.words[1]),'Jr.');
stream(['Smith','Jr.'],[0,0]);
S.words[0].mute=true;
assert.equal(helpers.spokenOfWord(S.words[1]),'Jr.','Suffix used a skipped name');

// A chunk may finish at No.; alignment must use the very same resolved form
// generation used before splitting, rather than guessing again inside it.
const no = {text:'number',whitespace:' ',phonemes:'n',startSec:.2};
assert.deepEqual(helpers.alignNativeTokenStarts(['No.'],[no],1,['number']),[.2]);
assert.equal(helpers.alignNativeTokenStarts(['No.'],[no],1),null);
console.log('pronunciation self-check: PASS (titles, acronyms/units, answers, labels, saved rules, blocks, mutes, pauses and chunk alignment)');
