'use strict';
// Diagnostics never select a target. Excerpts are bounded and only used after authorization.
function nearby(content, old) {
 const source=content.split(/\r?\n/), anchors=old.split(/\r?\n/).map(s=>s.trim()).filter(s=>s.length>3);
 let best=-1,score=0;
 for(let i=0;i<source.length;i++) {
  const line=source[i].trim();
  const value=anchors.includes(line)?2:anchors.some(a=>a.slice(0,Math.min(24,a.length)) && line.includes(a.slice(0,Math.min(24,a.length))))?1:0;
  if(value>score){score=value;best=i;}
 }
 if(best<0)return [];
 const start=Math.max(0,best-2),end=Math.min(source.length,best+7);
 return [{start_line:start+1,end_line:end,excerpt:source.slice(start,end).join('\n').slice(0,1000)}];
}
function mismatchExplanation(content,old) {
 const requested=old.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 if(requested.length<2 || !requested.every(s=>/^--[\w-]+\s*:/.test(s)))return undefined;
 const lines=content.split(/\r?\n/).map(s=>s.trim());
 const positions=requested.map(s=>lines.indexOf(s));
 if(positions.every(i=>i>=0) && positions.every((i,j)=>!j||i>positions[j-1]) && positions.some((i,j)=>j&&lines.slice(positions[j-1]+1,i).some(Boolean)))
  return 'The requested declarations are not adjacent: existing nonblank source lines intervene. Replace one unique declaration or include the actual intervening context.';
 return undefined;
}
function argumentError(args) {
 const edits=args?.edits;
 const base={zero_writes:true,batch_size:Array.isArray(edits)?edits.length:null};
 if(Array.isArray(edits)&&edits.length>20)return {...base,code:'EDIT_BATCH_LIMIT_EXCEEDED',maximum:20,received:edits.length,suggested_action:'Split into batches of 20 or fewer edits. No files modified.'};
 if(!Array.isArray(edits)||!edits.length)return {...base,code:'EDIT_ARGUMENT_INVALID',field:'edits',suggested_action:'Provide an array of 1–20 edits. No files modified.'};
 for(let i=0;i<edits.length;i++){
  const e=edits[i];
  if(e && typeof e==='object' && !Array.isArray(e)) {
   const extra=Object.keys(e).find(k=>!['relative_path','old_str','new_str'].includes(k));
   if(extra)return {...base,code:'EDIT_ARGUMENT_INVALID',edit_index:i,edit_number:i+1,field:extra,suggested_action:`Remove unsupported field ${extra} from edit ${i+1} (one-based). No files modified.`};
  }
  for(const field of ['relative_path','old_str','new_str'])if(!e||typeof e!=='object'||Array.isArray(e)||typeof e[field]!=='string'||(field!=='new_str'&&!e[field].trim()))return {...base,code:'EDIT_ARGUMENT_INVALID',edit_index:i,edit_number:i+1,field,missing_field:!e||!Object.hasOwn(e,field)?field:undefined,required_fields:['relative_path','old_str','new_str'],suggested_action:`Correct ${field} in edit ${i+1} (one-based). No files modified.`};
 }
 return null;
}
function throwDetails(details) {const error=new Error(`${details.code}: ${details.received !== undefined ? `Received ${details.received} edits; maximum ${details.maximum}. ` : ''}${details.edit_index !== undefined ? `Edit ${details.edit_number} (one-based), field ${details.field || 'target'}. ` : ''}${details.suggested_action}`);error.editDetails=details;throw error;}
module.exports={nearby,mismatchExplanation,argumentError,throwDetails};
