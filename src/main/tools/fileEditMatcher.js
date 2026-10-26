'use strict';
// Conservative textual matching: internal whitespace is never normalized.
const { nearby, mismatchExplanation } = require('./editDiagnostics');
const MAX = 2 * 1024 * 1024;
function fail(category, content, candidates, strategies, old = "") {
 const details = { category, strategies_attempted: strategies, changed_since_read: null,
  candidates: candidates.slice(0, 5).map(({start,end}) => ({ start_line: content.slice(0,start).split('\n').length, end_line: content.slice(0,end).split('\n').length, excerpt: content.slice(start,end).slice(0,240) })),
  nearby_source: nearby(content,old), explanation: mismatchExplanation(content,old), zero_writes: true,
  suggested_action: category === 'ambiguous-match' ? 'Provide more unchanged surrounding lines to identify one target.' : 'Provide complete surrounding lines from a small relevant range or use apply_patch.' };
 const error = new Error(`${category}: old_str ${category === 'ambiguous-match' ? 'is not unique' : 'was not found'}; ${details.suggested_action}`);
 error.editDetails = details; throw error;
}
function locateReplacement(content, old, filePath = null) {
 if (typeof old !== 'string' || !old) throw new Error('old_str must not be empty.');
 if (content.includes('\0')) throw new Error('Refusing binary file.');
 if (Buffer.byteLength(content) > MAX || Buffer.byteLength(old) > MAX) throw new Error('File or search exceeds editing size limit.');
 const strategies = [];
 const choose = (matches, strategy) => {
  strategies.push(strategy);
  if (matches.length > 1) fail('ambiguous-match', content, matches, strategies);
  return matches.length ? {...matches[0], strategy} : null;
 };
 const occurrences = (hay, needle, map = null) => {
  const found = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle,i+1)) {
   found.push({ start: map ? map[i] : i, end: map ? map[i+needle.length-1]+1 : i+needle.length });
   if (found.length === 6) break;
  } return found;
 };
 let result = choose(occurrences(content,old), 'exact'); if (result) return result;
 const map = []; let lf = '';
 for (let i=0;i<content.length;i++) { if (content[i] === '\r' && content[i+1] === '\n') continue; map.push(i); lf += content[i]; }
 result = choose(occurrences(lf,old.replace(/\r\n/g,'\n'),map),'line-endings'); if(result) return result;
 const css = /\.css$/i.test(filePath || '');
 const jsx = /\.[jt]sx$/i.test(filePath || '');
 if (filePath && !css && !/\.(?:[cm]?[jt]sx?|py|go|java|c|h|cpp|hpp|cs|rs|json|txt)$/i.test(filePath)) fail('unsafe-normalization',content,[],strategies,old);
 // Only CSS and JSX gain candidate-local tolerance; retain E1 checks elsewhere.
 if (!css && !jsx && (/[`]|'''|"""|\/\*|\\\r?\n/.test(content + old) || (content + '\n' + old).split('\n').some(line => {
  const clean = line.replace(/\\./g, '');
  return ['"', "'"].some(q => clean.split(q).length % 2 === 0);
 }))) fail('unsafe-normalization',content,[],strategies,old);
 let jsxTree;
 const safeRegion = (start,end) => {
  const region=content.slice(start,end);
  if(css) {
   // Do not normalize inside comments, strings, URLs or escaped continuations.
   // A region starting inside one is unsafe too, hence scan its prefix.
   const prefix=content.slice(0,start); let quote=null,comment=false;
   for(let i=0;i<prefix.length;i++) {const c=prefix[i],n=prefix[i+1];if(comment){if(c==='*'&&n==='/'){comment=false;i++;}}else if(quote){if(c==='\\')i++;else if(c===quote)quote=null;}else if(c==='/'&&n==='*'){comment=true;i++;}else if(c==='"'||c==="'")quote=c;}
   return !quote&&!comment&&!/\/\*|["']|url\s*\(|\\/i.test(region+old);
  }
  if(jsx) {
   // TypeScript's existing JSX parser identifies whitespace-sensitive literal spans.
   const ts=require('typescript');
   const tree=jsxTree ??= ts.createSourceFile(filePath,content,ts.ScriptTarget.Latest,true,/\.tsx$/i.test(filePath)?ts.ScriptKind.TSX:ts.ScriptKind.JSX);
   let safe=true;
   const sensitive=n=>ts.isStringLiteral(n)||ts.isRegularExpressionLiteral(n)||ts.isTemplateLiteralToken(n)||n.kind===ts.SyntaxKind.JsxText;
   const visit=n=>{if(n.end<start||n.pos>end)return;
    if(sensitive(n)&&n.getStart(tree)<end&&n.end>start) {
     const text=content.slice(Math.max(start,n.getStart(tree)),Math.min(end,n.end));
     if(n.kind===ts.SyntaxKind.JsxText ? Boolean(text.trim()) : text.includes('\n'))safe=false;
    }
    for(const r of ts.getLeadingCommentRanges(content,n.pos)||[])if(r.pos<end&&r.end>start)safe=false;
    ts.forEachChild(n,visit);
   };visit(tree);
   return safe&&!/\/\*|\\\r?\n/.test(region+old);
  }
  return !(/<[A-Za-z]/.test(region) && region.split('\n').some(l=>/^[\t ]+[\p{L}\p{N}][^<>{};=():]*$/u.test(l)));
 };
 const lines = text => { let offset=0; return text.split('\n').map(raw => { const value=raw.replace(/\r$/,''); const line={value,start:offset,end:offset+value.length}; offset+=raw.length+1; return line; }); };
 const source=lines(content), search=lines(old);
 let unsafe=false;
 const key = value => css ? value.trim().replace(/^(--[\w-]+)\s*:/, '$1:') : value.trim();
 for (const blank of [false,true]) {
  const a=blank ? source.filter(l=>l.value.trim()) : source;
  const b=blank ? search.filter(l=>l.value.trim()) : search;
  if (!b.length) break;
  const matches=[];
  for(let i=0;i<=a.length-b.length;i++) {
   if(b.every((l,j)=>key(l.value)===key(a[i+j].value))) {const start=a[i].start,end=a[i+b.length-1].end;matches.push({start,end});}
   if(matches.length===6) break;
  }
  result=choose(matches,blank?'blank-lines':'indentation'); if(result) {if(safeRegion(result.start,result.end))return result;unsafe=true;}
 }
 const anchors = new Set(search.map(l => l.value.trim()).filter(Boolean));
 const relevant = source.filter(l => anchors.has(l.value.trim())).slice(0,5);
 fail(unsafe?'unsafe-normalization':'no-match',content,relevant,strategies,old);
}
function replacementText(content, old, replacement, match) {
 if(typeof replacement!=='string' || Buffer.byteLength(replacement)>MAX) throw new Error('Replacement exceeds editing size limit or is not text.');
 if(match.strategy==='exact') return replacement;
 // Reindent code only; newly supplied multiline literals must remain verbatim.
 if (/[`]|'''|"""|\/\*/.test(replacement)) return replacement;
 const eol=content.slice(match.start,match.end).includes('\r\n')?'\r\n':'\n';
 let value=replacement.replace(/\r\n/g,'\n');
 // Rebase only a consistent indentation shift; never infer indentation units.
 const before=old.split(/\r?\n/).filter(l=>l.trim());
 const actual=content.slice(match.start,match.end).split(/\r?\n/).filter(l=>l.trim());
 const indent=l=>l.match(/^[\t ]*/)[0];
 if(before.length===actual.length && before.length) {
  const base=indent(before[0]), target=indent(actual[0]);
  if(before.every((l,i)=>l.startsWith(base) && indent(actual[i])===target+indent(l).slice(base.length)))
   value=value.split('\n').map(l=>l.trim() && l.startsWith(base)?target+l.slice(base.length):l).join('\n');
 }
 return value.replace(/\n/g,eol);
}
// Cache only pure matching failures, keyed by full current bytes and requested text.
// Authorization and fresh file reads remain mandatory at the dispatch layer.
const failures=new Map();
function cachedLocate(content,old,filePath=null) {
 const key=require('node:crypto').createHash('sha256').update(JSON.stringify([filePath,content,old])).digest('hex');
 if(failures.has(key)){const saved=failures.get(key),error=new Error(saved.message);error.editDetails=structuredClone(saved.details);error.editDetails.repeated_failure=true;throw error;}
 try{return locateReplacement(content,old,filePath);}catch(error){
  if(error.editDetails){if(failures.size>=32)failures.delete(failures.keys().next().value);failures.set(key,{message:error.message,details:structuredClone(error.editDetails)});}
  throw error;
 }
}
module.exports={locateReplacement:cachedLocate,replacementText};
