'use strict';
// Diagnostics never select a target. Excerpts are bounded and only used after authorization.
function nearby(content, old) {
 const source=content.split(/\r?\n/), requested=old.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 const counts=new Map();
 for(const raw of source){const line=raw.trim();counts.set(line,(counts.get(line)||0)+1);}
 // Rank a whole window, weighting distinctive lines over common tags/braces.
 const anchors=new Set(requested.filter(s=>s.length>3));
 const weights=source.map(raw=>{
  const line=raw.trim();
  if(anchors.has(line))return Math.min(80,line.length)/(counts.get(line)||1);
  return 0;
 });
 const width=Math.min(100,Math.max(1,old.split(/\r?\n/).length));
 let best=-1,score=0,sum=0;
 for(let i=0;i<source.length;i++) {
  sum+=weights[i];if(i>=width)sum-=weights[i-width];
  if(sum>score){score=sum;best=Math.max(0,i-width+1);}
 }
 if(best<0)return [];
 const start=Math.max(0,best-2),end=Math.min(source.length,best+width+2);
 return [{start_line:start+1,end_line:end,excerpt:source.slice(start,end).join('\n').slice(0,2000)}];
}
function mismatchExplanation(content,old) {
 const requested=old.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 if(requested.length<2)return undefined;
 const lines=content.split(/\r?\n/).map(s=>s.trim());
 const positions=requested.map(s=>lines.indexOf(s));
 if(requested.every(s=>/^--[\w-]+\s*:/.test(s)) && positions.every(i=>i>=0) && positions.every((i,j)=>!j||i>positions[j-1]) && positions.some((i,j)=>j&&lines.slice(positions[j-1]+1,i).some(Boolean)))
  return 'The requested declarations are not adjacent: existing nonblank source lines intervene. Replace one unique declaration or include the actual intervening context.';
 const window=nearby(content,old)[0];
 if(window) {
  const lower=Math.max(0,window.start_line-1),upper=Math.min(lines.length,window.end_line+requested.length+5);
  for(let start=lower;start<upper;start++) {
   if(lines[start]!==requested[0])continue;
   let at=start,skipped=null,matched=true;
   for(let j=1;j<requested.length;j++) {
    let next=at+1;
    while(next<upper&&lines[next]!==requested[j])next++;
    if(next===upper){matched=false;break;}
    for(let k=at+1;k<next;k++)if(lines[k]&&!skipped)skipped={line:k+1,text:lines[k]};
    at=next;
   }
   if(matched&&skipped)return `old_str omits existing source at line ${skipped.line}: ${JSON.stringify(skipped.text.slice(0,160))}. Include the intervening source lines or use a smaller unique target.`;
  }
 }
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
