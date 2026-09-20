import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {project} from '../src/model.js';
import {EditorSession} from '../src/editor-session.js';
import {MemoryStorage} from '../src/storage.js';
import {ProjectRepository} from '../src/repository.js';
import {sha256Hex, readBundle} from '../src/bundle.js';
import {TextDrafts} from '../src/text-drafts.js';
import {prepareProjectDownload,checkProjectSize,MAX_BUNDLE_BYTES} from '../src/project-io.js';
const asset = async(id, text=id) => {const bytes=new TextEncoder().encode(text);return {id,bytes,mime:'audio/wav',sha256:await sha256Hex(bytes)};};

test('atomic import rolls back quota failure and preserves existing assets',async()=>{
 const storage=new MemoryStorage(),repo=new ProjectRepository(storage);await repo.open();
 await repo.putAsset('existing',new Blob(['safe']));
 const put=storage.put.bind(storage);storage.put=async(s,k,v)=>{if(k==='two') throw Error('QuotaExceededError');await put(s,k,v);};
 let adopted=false;
 await assert.rejects(repo.importAssets([await asset('one'),await asset('two')],{adopt:()=>adopted=true}),/Quota/);
 assert.deepEqual(await repo.assetIds(),['existing']);assert.equal(adopted,false);
});
test('late ID conflict is detected before any asset is written',async()=>{
 const repo=new ProjectRepository(new MemoryStorage());await repo.open();await repo.putAsset('two',new Blob(['original']));
 await assert.rejects(repo.importAssets([await asset('one'),await asset('two')]),/違います/);
 assert.deepEqual(await repo.assetIds(),['two']);
});
test('session/revision change during a batch aborts all additions',async()=>{
 const storage=new MemoryStorage(),repo=new ProjectRepository(storage);await repo.open();let current=true, adopted=false;
 const put=storage.put.bind(storage);storage.put=async(...args)=>{await put(...args);current=false;};
 await assert.rejects(repo.importAssets([await asset('one')],{isCurrent:()=>current,adopt:()=>adopted=true}),/編集が変わり/);
 assert.deepEqual(await repo.assetIds(),[]);assert.equal(adopted,false);
});
test('change at transaction completion removes additions, never shared assets',async()=>{
 const storage=new MemoryStorage(),repo=new ProjectRepository(storage);await repo.open();const shared=await asset('shared');await repo.putAsset(shared.id,new Blob([shared.bytes]));
 let current=true;const batch=storage.batch.bind(storage);storage.batch=async(...args)=>{await batch(...args);current=false;};
 await assert.rejects(repo.importAssets([shared,await asset('one')],{isCurrent:()=>current}),/編集が変わり/);
 assert.deepEqual(await repo.assetIds(),['shared']);
});
test('same-ID same-hash imports reuse assets and adopt once',async()=>{
 const repo=new ProjectRepository(new MemoryStorage());await repo.open();const a=await asset('one');let count=0;
 await repo.importAssets([a],{adopt:()=>count++});await repo.importAssets([a],{adopt:()=>count++});
 assert.deepEqual(await repo.assetIds(),['one']);assert.equal(count,2);
});
test('download freezes the project before awaiting assets and returns original revision',async()=>{
 const p=project(), editor=new EditorSession();const token=editor.capture();p.title='before';const a=await asset('one');
 p.assets.push({id:a.id,kind:'audio',name:'one.wav',mime:a.mime,bytes:a.bytes.length});
 let release=false,proceed;const repo={retainAsset:()=>()=>release=true,getAsset:()=>new Promise(r=>proceed=r)};
 const work=prepareProjectDownload(p,token,repo);p.title='after';editor.edit(p=>p.title='after');proceed(new Blob([a.bytes]));
 const result=await work;assert.equal(result.name,'before.contb');assert.equal((await readBundle(result.blob)).project.title,'before');
 assert.equal(editor.isCurrentRevision(result.token),false);assert.ok(release);
});
test('51 MB bundle round-trips under the same open/save limit',async()=>{
 const p=project(),repo=new ProjectRepository(new MemoryStorage());await repo.open();const bytes=new Uint8Array(51_000_000);
 p.assets.push({id:'large',kind:'audio',name:'large.wav',mime:'audio/wav',bytes:bytes.length});await repo.putAsset('large',new Blob([bytes]));
 const {blob}=await prepareProjectDownload(p,{},repo);assert.ok(blob.size>50e6);checkProjectSize(blob.size,true);
 assert.equal((await readBundle(blob)).assets[0].bytes.length,bytes.length);
 assert.throws(()=>checkProjectSize(MAX_BUNDLE_BYTES+1,true));assert.throws(()=>checkProjectSize(51e6,false));
});
test('IME drafts survive until composition ends and retain their original target',async()=>{
 const committed=[];const drafts=new TextDrafts(entries=>committed.push(entries),{delay:10,maxDelay:20});
 drafts.composition('notes',true);drafts.stage('notes',{target:'panel-A',value:'変換中'});await delay(30);
 assert.equal(committed.length,0);assert.ok(drafts.pending);
 drafts.stage('notes',{target:'panel-A',value:'変換後'});drafts.composition('notes',false);await delay(30);
 assert.deepEqual(committed,[[{target:'panel-A',value:'変換後'}]]);assert.equal(drafts.pending,false);
});
test('save/visibility flush captures pending composition, failed commits keep drafts',()=>{
 let fail=true;const drafts=new TextDrafts(()=>{if(fail)throw Error('failure');});drafts.composition('title',true);drafts.stage('title',{value:'未確定'});
 assert.throws(()=>drafts.flush());assert.ok(drafts.pending);fail=false;drafts.flush();assert.equal(drafts.pending,false);drafts.clear();
});
