const {test}=require('node:test');
const assert=require('node:assert/strict');
const {locateReplacement:locate,replacementText}=require('../src/main/tools/fileEditMatcher');
const fixtures=[
 ['exact','a();\nb();','a();','c();'],
 ['crlf','a();\r\nb();','a();\nb();','c();\nd();'],
 ['indent','    if (x) {\n        go();\n    }','if (x) {\n  go();\n}','if (x) {\n  stop();\n}'],
 ['tabs','\tgo();','    go();','    stop();'],
 ['blank','if (x) {\n\n  go();\n}','if (x) {\n  go();\n}','if (x) {\n  stop();\n}'],
 ['trailing','go();  ','go();','stop();'],
 ['shift','    if (x) {\n      go();\n    }','if (x) {\n  go();\n}','if (x) {\n  stop();\n}'],
 ['jsx','    <div>\n      <span />\n    </div>','<div>\n  <span />\n</div>','<div>\n  <b />\n</div>'],
 ['python','    if ready:\n        run()','if ready:\n    run()','if ready:\n    stop()'],
 ['unicode','    print("বাংলা")','print("বাংলা")','print("世界")'],
 ['large','// untouched\n'.repeat(40000)+'    unique();','unique();','changed();'],
];
for(const [name,content,old,next] of fixtures) test(name,()=>{
 const match=locate(content,old), replacement=replacementText(content,old,next,match);
 const output=content.slice(0,match.start)+replacement+content.slice(match.end);
 assert.equal(output.slice(0,match.start),content.slice(0,match.start));
 assert.equal(output.slice(match.start+replacement.length),content.slice(match.end));
 assert.notEqual(output,content);
});
for(const [name,content,old,category] of [
 ['duplicate','x();\nx();','x();','ambiguous-match'],
 ['near duplicate','  x();\n    x();',' x();','ambiguous-match'],
 ['string','const s="a  b";','const s="a b";','no-match'],
 ['template','const s=`a\n  b`;','const s=`a\n b`;','unsafe-normalization'],
 ['jsx duplicate','  <X />\n    <X />',' <X />','ambiguous-match'],
 ['conflict','newValue();','oldValue();','no-match'],
 ['unsafe','/*\n  literal\n*/','/*\n literal\n*/','unsafe-normalization'],
]) test(name,()=>{assert.throws(()=>locate(content,old),e=>{assert.equal(e.editDetails.category,category);if(category==='ambiguous-match')assert.equal(e.editDetails.candidates.length,2);return true;});});
test('sequential edits use current content',()=>{let content='  a();\n  b();';for(const [old,next] of [['a();','c();'],['c();','d();'],['b();','e();']]){const m=locate(content,old);content=content.slice(0,m.start)+replacementText(content,old,next,m)+content.slice(m.end);}assert.equal(content,'  d();\n  e();');});
test('binary and oversized replacement reject',()=>{assert.throws(()=>locate('a\0b','a'));assert.throws(()=>replacementText('x','x','x'.repeat(2097153),{strategy:'exact'}));});
test('consistent shift preserves Python nesting',()=>{const content='    if ready:\n        run()';const old='if ready:\n    run()';const m=locate(content,old);assert.equal(replacementText(content,old,'if ready:\n    stop()',m),'    if ready:\n        stop()');});
test('multiline quoted content rejects tolerant editing',()=>{assert.throws(()=>locate('const s = "a\n  b";', 'const s = "a\n b";'),e=>e.editDetails.category==='unsafe-normalization');});
module.exports={fixtures};
