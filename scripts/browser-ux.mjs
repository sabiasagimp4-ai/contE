import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from './serve.mjs';
import {project,panel} from '../src/model.js';
import {readBundle} from '../src/bundle.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
const server=await serve(resolve('.'),0);
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
const p=project();p.title='UX review';p.scenes[0].shots[0].panels.push(panel(),panel());
p.scenes[0].shots[0].panels.forEach((b,i)=>b.notes=`note-${i}`);
const ids=p.scenes[0].shots[0].panels.map(b=>b.id);
const openFixture=async()=>{
 await page.locator('#file').setInputFiles({name:'ux.contp',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});
 await page.waitForFunction(()=>document.querySelector('#title').value==='UX review');
};
const latest=async()=>{
 await page.waitForFunction(()=>document.querySelector('#savestate').textContent.startsWith('ブラウザに保存'));
 return page.evaluate(async()=>{const {ProjectRepository}=await import('./src/repository.js');const {IndexedDbStorage}=await import('./src/storage.js');const r=new ProjectRepository(new IndexedDbStorage());await r.open();const latest=await r.latest();r.storage.close();return latest.project;});
};
const saved=async()=>{
 const waiting=page.waitForEvent('download');await page.locator('#save').click();const d=await waiting;
 return {project:(await readBundle(await readFile(await d.path()))).project,name:d.suggestedFilename(),download:d};
};
try {
 await page.goto(`http://127.0.0.1:${server.address().port}`);await openFixture();
 assert.match(await page.locator('#file').getAttribute('accept'),/\.contb/);
 // Drafts reach persistent storage without blur; IME text survives a render.
 await page.locator('#notes').fill('unblurred draft');
 assert.equal((await latest()).scenes[0].shots[0].panels[0].notes,'unblurred draft');
 await page.locator('#notes').evaluate(el=>{
   el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='変換途中';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
   document.querySelector('#keyList').dispatchEvent(new Event('change',{bubbles:true}));
 });
 assert.equal(await page.locator('#notes').inputValue(),'変換途中');
 await page.locator('#notes').evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
 assert.equal((await latest()).scenes[0].shots[0].panels[0].notes,'変換途中');
 // Ctrl-S works during text editing and captures the latest draft.
 await page.locator('#notes').fill('save from textarea');const dl=page.waitForEvent('download');await page.keyboard.press('Control+s');const downloaded=await dl;
 assert.equal(downloaded.suggestedFilename(),'UX review.contb');
 assert.equal((await readBundle(await readFile(await downloaded.path()))).project.scenes[0].shots[0].panels[0].notes,'save from textarea');
 // Mixed values are visible; ordinary text edits change only active panel.
 await page.locator('#strip button').first().click();await page.locator('#strip button').nth(1).click({modifiers:['Shift']});
 assert.match(await page.locator('#selectionInfo').innerText(),/2コマ選択中.*混在/);
 await page.locator('#notes').fill('only second');await page.locator('#notes').blur();let data=(await saved()).project;
 assert.equal(data.scenes[0].shots[0].panels[0].notes,'save from textarea');assert.equal(data.scenes[0].shots[0].panels[1].notes,'only second');
 await page.locator('#bulkText').click();data=(await saved()).project;assert.equal(data.scenes[0].shots[0].panels[0].notes,'only second');
 await page.locator('[data-act=undo]').click();
 // Scrub to second panel, draw, and assert no stroke was recorded on first.
 await page.locator('#strip button').first().click();
 const second=await page.locator('.clip').nth(1).boundingBox();const ruler=await page.locator('#ruler').boundingBox();
 await page.mouse.click(second.x+20,ruler.y+4);
 assert.match(await page.locator('#breadcrumb').innerText(),/Panel 2/);
 const canvas=await page.locator('#drawing').boundingBox();await page.mouse.move(canvas.x+canvas.width*.4,canvas.y+canvas.height*.5);await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.6,canvas.y+canvas.height*.5,{steps:8});await page.mouse.up();
 data=(await saved()).project;assert.equal(data.scenes[0].shots[0].panels[0].strokes.length,0);assert.equal(data.scenes[0].shots[0].panels[1].strokes.length,1);
 // Delete selected Panel, not a hidden camera key.
 await page.locator('#strip button').nth(1).click();await page.keyboard.press('Delete');assert.equal(await page.locator('#strip button').count(),2);await page.locator('[data-act=undo]').click();
 // Camera frame drag changes current key, and undo restores it.
 await page.locator('[data-tab=camera]').click();const frame=await page.locator('#cameraFrame').boundingBox();
 const xBefore=await page.locator('#cx').inputValue();await page.mouse.move(frame.x+frame.width*.45,frame.y+frame.height*.4);await page.mouse.down();await page.mouse.move(frame.x+frame.width*.45+25,frame.y+frame.height*.4+10,{steps:4});await page.mouse.up();
 assert.notEqual(await page.locator('#cx').inputValue(),xBefore);await page.locator('[data-act=undo]').click();assert.equal(await page.locator('#cx').inputValue(),xBefore);
 await page.locator('#cameraPreview').check();assert.equal(await page.locator('#cameraOverlay').isVisible(),false);
 await page.locator('[data-tab=content]').click();
 // Tree collapse and keyboard focus survive unrelated rendering.
 await page.locator('#tree summary').click();assert.equal(await page.locator('#tree details').first().getAttribute('open'),null);
 await page.locator('#strip button').first().click();await page.keyboard.press(']');assert.equal(await page.locator('#tree details').first().getAttribute('open'),null);
 assert.ok(await page.evaluate(()=>document.activeElement?.dataset.focusKey?.startsWith('strip-')));
 assert.ok(await page.locator('.timeline-thumb').count()>0);assert.match(await page.locator('.clip').first().getAttribute('title'),/Shot 1/);
 // Paper controls reflect stored order immediately, also after reopening.
 await page.locator('#paper').click();await page.locator('#paperColumns .column').first().locator('button').nth(1).click();
 assert.match(await page.locator('#paperColumns .column').first().innerText(),/コンテ画像/);
 await page.locator('#closePaper').click();await page.locator('#paper').click();assert.match(await page.locator('#paperColumns .column').first().innerText(),/コンテ画像/);await page.locator('#closePaper').click();
 // Every inspector tab remains reachable on a narrow display.
 await page.setViewportSize({width:390,height:844});await page.locator('#toggleInspector').click();await page.locator('[data-tab=sound]').click();assert.ok(await page.locator('#audioAdd').isVisible());
 await page.locator('[data-tab=content]').click();assert.ok(await page.locator('#notes').isVisible());await page.locator('#closeInspector').click();
 await page.setViewportSize({width:1440,height:1000});
 // Save delayed in hashing; edits after the snapshot remain file-dirty.
 await page.evaluate(async()=>{
   const {ProjectRepository}=await import('./src/repository.js');const {IndexedDbStorage}=await import('./src/storage.js');
   const repo=new ProjectRepository(new IndexedDbStorage());await repo.open();
   // Use a tiny genuine image so Bundle generation must cross an asynchronous digest.
   const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
   const blob=await new Promise(r=>canvas.toBlob(r));const dt=new DataTransfer();dt.items.add(new File([blob],'tiny.png',{type:'image/png'}));const input=document.querySelector('#imageFile');input.files=dt.files;input.dispatchEvent(new Event('change'));repo.storage.close();
 });
 await page.waitForFunction(()=>document.querySelector('#assetInfo').textContent.includes('tiny.png'));
 await page.evaluate(()=>{const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(...args)=>{if(!window.heldDigest){window.heldDigest=true;await new Promise(r=>window.releaseDigest=r);}return digest(...args);};});
 const saving=page.waitForEvent('download');await page.locator('#save').click();await page.waitForFunction(()=>!!window.releaseDigest);
 await page.locator('#notes').fill('edited during save');await page.locator('#notes').blur();await page.evaluate(()=>window.releaseDigest());const out=await saving;
 assert.match(await page.locator('#filestate').innerText(),/未保存/);assert.notEqual((await readBundle(await readFile(await out.path()))).project.scenes[0].shots[0].panels[0].notes,'edited during save');
 // File picker can reopen the generated Bundle, with assets intact.
 await page.locator('#file').setInputFiles({name:out.suggestedFilename(),mimeType:'application/zip',buffer:await readFile(await out.path())});
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Bundleを読み込みました'));
 // Long errors remain fully readable and retryable.
 await page.locator('#file').setInputFiles({name:'broken.contp',mimeType:'application/json',buffer:Buffer.from('{broken')});
 await page.waitForFunction(()=>!document.querySelector('#errorNotice').hidden);assert.ok(await page.locator('#noticeRetry').isVisible());
 assert.ok((await page.locator('#noticeText').innerText()).length>0);
 assert.deepEqual(errors,[]);console.log('UX regressions passed');
} finally {await context.close();await browser.close();server.close();}
