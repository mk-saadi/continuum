'use strict';
// Unique textual matching; JSX indentation is tolerant only when rendered text agrees.
const { nearby, mismatchExplanation } = require('./editDiagnostics');
const MAX = 2 * 1024 * 1024;
function fail(category, content, candidates, strategies, old = "", reason = null) {
 const details = { category, strategies_attempted: strategies, changed_since_read: null,
  candidates: candidates.slice(0, 5).map(({start,end}) => ({ start_line: content.slice(0,start).split('\n').length, end_line: content.slice(0,end).split('\n').length, excerpt: content.slice(start,end).slice(0,240) })),
  nearby_source: reason && candidates.length ? candidates.slice(0,1).map(({start,end})=>({start_line:content.slice(0,start).split('\n').length,end_line:content.slice(0,end).split('\n').length,excerpt:content.slice(start,end).slice(0,2000)})) : nearby(content,old), explanation: reason?.message || mismatchExplanation(content,old), normalization_blocker: reason, zero_writes: true,
  suggested_action: category === 'ambiguous-match' ? 'Provide more unchanged surrounding lines to identify one target.' : 'Provide complete surrounding lines from a small relevant range or use apply_patch.' };
 const description = reason?.message || details.explanation || (category === 'ambiguous-match' ? 'old_str matches multiple locations.' : 'No source range matches old_str using the attempted strategies.');
 const error = new Error(`${category}: ${description} ${details.suggested_action}`);
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
 let jsxTree, blocker=null, preserveWhitespace=false;
 const rejected=[];
 const safeRegion = (start,end) => {
  blocker=null;preserveWhitespace=false;
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
   // Compare only whitespace discarded by line matching. Keep internal characters
   // as anchors so differences inside literals/comments can be located precisely.
   const anchors = text => {
    const result=[]; let offset=0;
    for(const line of text.split('\n')) {
     const left=line.length-line.trimStart().length, right=line.trimEnd().length;
     for(let i=left;i<right;i++)result.push(offset+i);
     offset+=line.length+1;
    }
    return result;
   };
   const actual=anchors(region), requested=anchors(old), changes=[];
   // Match TypeScript's JSX emit whitespace rules. Entity bytes already agree
   // under line matching, so entity decoding is unnecessary for comparison.
   const rendered = text => {
    let value, first=0, last=-1;
    for(let i=0;i<text.length;i++) {
     if(/[\r\n\u2028\u2029]/.test(text[i])) {
      if(first!==-1&&last!==-1)value=value===undefined?text.slice(first,last+1):value+' '+text.slice(first,last+1);
      first=-1;
     } else if(!/\s/.test(text[i])) {last=i;if(first===-1)first=i;}
    }
    if(first!==-1)value=value===undefined?text.slice(first):value+' '+text.slice(first);
    return value || '';
   };
   const jsxTexts = (tree,from,to) => {
    const texts=[];
    const walk=n=>{
     if(n.end<from||n.pos>to)return;
     if(n.kind===ts.SyntaxKind.JsxText&&n.pos<to&&n.end>from)texts.push({start:n.pos,end:n.end,value:rendered(tree.text.slice(n.pos,n.end))});
     ts.forEachChild(n,walk);
    };walk(tree);return texts;
   };
   const alternate=content.slice(0,start)+old+content.slice(end);
   const alternateTree=ts.createSourceFile(filePath,alternate,ts.ScriptTarget.Latest,true,/\.tsx$/i.test(filePath)?ts.ScriptKind.TSX:ts.ScriptKind.JSX);
   const actualText=jsxTexts(tree,start,end), oldText=jsxTexts(alternateTree,start,start+old.length);
   const values=texts=>texts.map(t=>t.value).filter(Boolean);
   const jsxEqual=JSON.stringify(values(actualText))===JSON.stringify(values(oldText));
   for(let i=0;i<=actual.length;i++) {
    const from=i?actual[i-1]+1:0, to=i<actual.length?actual[i]:region.length;
    const oldFrom=i?requested[i-1]+1:0, oldTo=i<requested.length?requested[i]:old.length;
    if(region.slice(from,to).replace(/\r\n/g,'\n')!==old.slice(oldFrom,oldTo).replace(/\r\n/g,'\n'))
     changes.push({start:start+from,end:start+to,source_whitespace:region.slice(from,to),requested_whitespace:old.slice(oldFrom,oldTo)});
   }
   const block = (from,to,kind) => {
    if(from<end&&to>start)preserveWhitespace=true;
    const change=changes.find(c=>c.start===c.end ? c.start>from&&c.start<to : c.start<to&&c.end>from);
    if(!change || blocker)return;
    const line=content.slice(0,Math.max(from,change.start)).split('\n').length;
    blocker={kind,line,source_whitespace:change.source_whitespace,requested_whitespace:change.requested_whitespace,message:`A whitespace-normalized candidate was found at lines ${content.slice(0,start).split('\n').length}–${content.slice(0,end).split('\n').length}, but whitespace differs inside ${kind} at line ${line}. This text must match exactly.`};
   };
   const visit=n=>{if(n.end<start||n.pos>end)return;
    if(ts.isStringLiteral(n)||ts.isRegularExpressionLiteral(n)||ts.isTemplateLiteralToken(n)||n.kind===ts.SyntaxKind.JsxText) {
     const from=n.kind===ts.SyntaxKind.JsxText?n.pos:n.getStart(tree);
     if(n.kind===ts.SyntaxKind.JsxText) {
      if(rendered(content.slice(from,n.end)))preserveWhitespace=true;
      if(!jsxEqual)block(from,n.end,'JSX text (rendered whitespace would change)');
     } else block(from,n.end,ts.isTemplateLiteralToken(n)?'a template literal':ts.isRegularExpressionLiteral(n)?'a regular expression':'a string literal');
    }
    for(const r of [...(ts.getLeadingCommentRanges(content,n.pos)||[]),...(ts.getTrailingCommentRanges(content,n.end)||[])])block(r.pos,r.end,'a comment');
    ts.forEachChild(n,visit);
   };visit(tree);
   if(!jsxEqual&&!blocker) {
    const line=content.slice(0,start).split('\n').length;
    blocker={kind:'JSX text (rendered whitespace would change)',line,message:`A whitespace-normalized candidate was found at line ${line}, but the requested whitespace changes rendered JSX text. Preserve significant inline spaces.`};
   }
   if(!blocker) {
    const diagnostic=tree.parseDiagnostics.find(d=>d.start<end&&d.start+(d.length||1)>start);
    if(diagnostic) {
     const line=content.slice(0,diagnostic.start).split('\n').length;
     blocker={kind:'unparseable source',line,message:`A whitespace-normalized candidate was found, but its source cannot be parsed safely at line ${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')} Copy the exact source text before editing.`};
    }
   }
   return !blocker;
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
  result=choose(matches,blank?'blank-lines':'indentation'); if(result) {if(safeRegion(result.start,result.end))return preserveWhitespace ? {...result,preserveWhitespace:true} : result;unsafe=true;rejected.push(result);}
 }
 const anchors = new Set(search.map(l => l.value.trim()).filter(Boolean));
 const relevant = source.filter(l => anchors.has(l.value.trim())).slice(0,5);
 fail(unsafe?'unsafe-normalization':'no-match',content,rejected.length?rejected:relevant,strategies,old,blocker);
}
function replacementText(content, old, replacement, match) {
 if(typeof replacement!=='string' || Buffer.byteLength(replacement)>MAX) throw new Error('Replacement exceeds editing size limit or is not text.');
 if(match.strategy==='exact' || match.preserveWhitespace) return replacement;
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
