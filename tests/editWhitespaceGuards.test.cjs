'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {locateReplacement:locate,replacementText}=require('../src/main/tools/fileEditMatcher');
for(const [name,body] of [
 ['JSX text','<span>Hello world</span>'],
 ['template','{`first\n  literal`}'],
 ['comment','{/* first\n  comment */}'],
 ['string','<span title="hello world" />'],
])test(`surrounding indentation accepts unchanged ${name}`,()=>{
 const source=`const a=(\n    <div>\n${body}\n    </div>\n);`;
 const old=`<div>\n${body}\n</div>`;
 const m=locate(source,old,'a.jsx');
 const next=old.replace('<div>','<section>').replace('</div>','</section>');
 const text=replacementText(source,old,next,m);
 assert.ok(text.includes(body));
 assert.equal(source.slice(0,m.start)+text+source.slice(m.end),`const a=(\n${next}\n);`);
});
for(const [kind,source,old] of [

 ['a template literal','const a=`first\n  second`;','const a=`first\n second`;'],
 ['a comment','/* first\n  second */','/* first\n second */'],
 ['unparseable source','const a="first\n  second";','const a="first\n second";'],

])test(`protected difference reports ${kind}: ${JSON.stringify(source)}`,()=>{
 assert.throws(()=>locate(source,old,'a.jsx'),e=>{
  assert.equal(e.editDetails.category,'unsafe-normalization');
  assert.equal(e.editDetails.normalization_blocker.kind,kind);
  assert.ok(e.editDetails.normalization_blocker.line>=1);
  assert.match(e.message,/candidate was found/);
  assert.match(e.message,kind==='unparseable source'?/cannot be parsed safely/:/whitespace differs inside/);
  assert.equal(e.editDetails.zero_writes,true);
  assert.doesNotMatch(e.message,/old_str was not found/);
  return true;
 });
});
test('ambiguous candidates stay ambiguous even with protected text',()=>{
 assert.throws(()=>locate('  <span>Hello</span>\n    <span>Hello</span>',' <span>Hello</span>','a.jsx'),e=>e.editDetails.category==='ambiguous-match');
});

for(const [source,old] of [
 ['const a=<div>first\n  second</div>;','const a=<div>first\n second</div>;'],
 ['const a=<div>first\n\nsecond</div>;','const a=<div>first\nsecond</div>;'],
 ['const a=(\n\t\t<span title="Local file">\n\t\t\tLocal\n\t\t</span>\n);','<span title="Local file">\n Local\n</span>'],
])test(`render-equivalent JSX whitespace: ${JSON.stringify(source)}`,()=>assert.ok(locate(source,old,'a.jsx')));
for(const [source,old] of [
 ['const a=<div>Hello  world</div>;','const a=<div>Hello world</div>;'],
 ['const a=<div>Hello <b>world</b></div>;','const a=<div>Hello<b>world</b></div>;'],
 ['const a=<div>{" "}world</div>;','const a=<div>{""}world</div>;'],
 ['const a=<span title="first\n  second" />;','const a=<span title="first\n second" />;'],
 ['const a=<div>hello\n world  </div>;','const a=<div>hello\n world </div>;'],
])test(`significant text is never collapsed: ${JSON.stringify(source)}`,()=>assert.throws(()=>locate(source,old,'a.jsx')));
test('diagnostics report rejected candidate and actual whitespace',()=>{
 const source='const other=<span />;\n'.repeat(100)+'const value=`hello\n  world`;';
 assert.throws(()=>locate(source,'const value=`hello\n world`;','a.jsx'),e=>{
  assert.equal(e.editDetails.nearby_source[0].start_line,101);
  assert.equal(e.editDetails.candidates[0].start_line,101);
  assert.equal(e.editDetails.normalization_blocker.source_whitespace,'\n  ');
  assert.equal(e.editDetails.normalization_blocker.requested_whitespace,'\n ');
  return true;
 });
});
test('accepted JSX formatting agrees with TypeScript emission',()=>{
 const ts=require('typescript');
 const emit=source=>ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const bodies=[
  '<span>\nINDENTLocal\n</span>',
  '<div>hello\nINDENTworld  </div>',
  '<div>\nINDENT&amp; hello\n\nINDENTworld\n</div>',
  '<div>\nINDENT<b />\nINDENT<span>Hello</span>\n</div>',
  '<div>\nINDENT{" "}hello\nINDENT{value}\n</div>',
 ];
 for(const body of bodies)for(const indent of [' ','\t','    ','\t\t']) {
  const source='const view=('+body.replaceAll('INDENT','\t\t\t')+');';
  const old='const view=('+body.replaceAll('INDENT',indent)+');';
  const m=locate(source,old,'a.jsx');
  assert.equal(emit(source),emit(old));
  assert.equal(emit(source),emit(source.slice(0,m.start)+replacementText(source,old,old,m)+source.slice(m.end)));
 }
});
