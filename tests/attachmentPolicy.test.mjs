import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPolicy, assertAttachmentNames } from '../src/lib/attachmentPolicy.mjs';
test('documents stay available while unknown media is rejected', () => {
 const policy=attachmentPolicy();
 assertAttachmentNames(['notes.txt','data.xlsx','paper.pdf','code.py'],policy);
 assert.throws(()=>assertAttachmentNames(['photo.png'],policy),/unsupported or unverified/);
 assert.throws(()=>assertAttachmentNames(['clip.mp4'],policy),/unsupported or unverified/);
 assert.throws(()=>assertAttachmentNames(['recording.wav'],policy),/unsupported or unverified/);
 assert.ok(!policy.accept.includes('.mp4'));
});
test('local and OpenRouter input permissions include only supported modalities',()=>{
 const caps={image:true,audio:true,video:true};
 assertAttachmentNames(['photo.png','clip.mp4','recording.mp3'],attachmentPolicy(caps,{local:true}));
 assertAttachmentNames(['clip.mp4'],attachmentPolicy(caps,{service:'OpenRouter',apiType:'openai'}));
 assert.throws(()=>assertAttachmentNames(['clip.mp4'],attachmentPolicy(caps,{apiType:'openai',service:'Custom'})),/unsupported/);
 assert.throws(()=>assertAttachmentNames(['recording.mp3'],attachmentPolicy(caps,{apiType:'anthropic'})),/unsupported/);
 assert.throws(()=>assertAttachmentNames(['photo.jpg'],attachmentPolicy({image:false},{local:true})),/unsupported/);
});
