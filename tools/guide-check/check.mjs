/* Tools-only live-browser gate. The app never imports this file. */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtures = path.join(root, 'tools/guide-check/fixtures');
const list = async dir => (await fs.readdir(dir)).filter(f => /\.html?$/i.test(f)).sort().map(f => path.join(dir, f));
const files = await list(fixtures);
assert(files.length, 'No synthetic fixtures');
if (process.env.GUIDE_DIR) files.push(...await list(path.resolve(process.env.GUIDE_DIR)));
const assets = new Set(['index.html','sw.js','manifest.json','kokoro-worker.js','icon-192.png','icon-512.png','icon-maskable.png','apple-touch-icon.png']);
const server = http.createServer(async (req,res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const match = pathname.match(/^\/fixture\/(\d+)$/);
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = match ? files[+match[1]] : assets.has(name) ? path.join(root,name) : null;
    if (!file) { res.writeHead(404); res.end(); return; }
    const data = await fs.readFile(file);
    res.setHeader('Content-Type', /\.html?$/.test(file) ? 'text/html' : /\.js$/.test(file) ? 'text/javascript' : /\.json$/.test(file) ? 'application/json' : 'image/png');
    res.end(data);
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, checking = "starting";
const collapseSelector = '.sec > .sechead, .sec > .head, .collapse-btn';
const revealSelector = '.rvb, .chk.rv, .quiz.sa button';
const mode = scope => scope.locator('button').filter({hasText:/\bmode\s*:/i}).first();
const signature = locator => locator.evaluate(el => JSON.stringify([el.className,el.textContent,el.dataset.closed,el.parentElement.className,el.parentElement.dataset.done]));
async function click(locator) {
  await locator.evaluate(el=>el.scrollIntoView({block:'center'}));
  await locator.click({position:{x:8,y:8}});
}
async function revealAncestors(scope, locator) {
  const ids = await locator.evaluate(el => {const ids=[];for(let p=el.parentElement;p;p=p.parentElement)if(p.matches('.sec')&&!p.classList.contains('open'))ids.unshift(p.id);return ids;});
  for (const id of ids) await click(scope.locator(`[id=${JSON.stringify(id)}]`).locator(':scope > .sechead, :scope > .head').first());
}
async function capabilities(scope) {
  return {collapse:await scope.locator(collapseSelector).count(),done:await scope.locator('.done').count(),flip:await scope.locator('.flip,.card').count(),quiz:await scope.locator('.quiz:not(.sa)').count(),reveal:await scope.locator(revealSelector).count(),mode:await mode(scope).count(),search:await scope.locator('input#q,input[type=search]').count()};
}
async function exercise(scope, expected) {
  assert.deepEqual(await capabilities(scope),expected,'Wrapping changed authored widget availability');
  const collapse=scope.locator(collapseSelector).first();
  if(expected.collapse){const before=await signature(collapse);await click(collapse);assert.notEqual(await signature(collapse),before,'Collapse did not respond');await click(collapse);assert.equal(await signature(collapse),before);}
  if(expected.flip){const card=scope.locator('.flip,.card').first();await revealAncestors(scope,card);const before=await signature(card);const answer=card.locator('.a');const answerBefore=await answer.count()?await signature(answer):null;await click(card);assert(await signature(card)!==before || answerBefore!==null&&await signature(answer)!==answerBefore,'Flip did not respond');}
  if(expected.quiz){const quiz=scope.locator('.quiz:not(.sa)').first();await revealAncestors(scope,quiz);const correct=await quiz.getAttribute('data-correct');assert(correct,'Quiz has no answer oracle');const radios=quiz.locator('input[type=radio]');if(await radios.count())await radios.nth('ABCD'.indexOf(correct)).check();else await click(quiz.locator(`[data-l=${JSON.stringify(correct)}]`));await click(quiz.locator('.chk:not(.rv),button').first());assert(await quiz.locator('.opt-correct').count(),'Quiz grading did not run');}
  if(expected.reveal){const button=scope.locator(revealSelector).first();await revealAncestors(scope,button);const answer=await button.evaluateHandle(b=>b.nextElementSibling);const before=await answer.evaluate(el=>el.className);await click(button);assert.notEqual(await answer.evaluate(el=>el.className),before,'Reveal did not respond');assert(await answer.evaluate(el=>getComputedStyle(el).display!=='none'),'Revealed answer is still hidden');await answer.dispose();}
  if(expected.search){const input=scope.locator('input#q,input[type=search]').first();await input.fill('__no_matching_content_64981__');await scope.waitForFunction(()=>[...document.querySelectorAll('.sec')].every(el=>getComputedStyle(el).display==='none'));await input.fill('');await scope.waitForFunction(()=>[...document.querySelectorAll('.sec')].every(el=>getComputedStyle(el).display!=='none'));}
  if(expected.done){const button=scope.locator('.done').first();const before=await signature(button);await click(button);assert.notEqual(await signature(button),before,'Mark done did not respond');}
  if(expected.mode){const button=mode(scope);assert.equal(await button.evaluate(b=>getComputedStyle(b).position),'fixed');const before=await button.textContent();await click(button);assert.notEqual(await button.textContent(),before,'Mode did not respond');}
  // Some input guides persist collapse rather than progress; leave a non-default state to verify restore.
  if(!expected.done&&!expected.mode&&expected.collapse)await click(collapse);
}
async function restoredSignature(scope, expected){return JSON.stringify({done:expected.done?await signature(scope.locator('.done').first()):null,mode:expected.mode?await mode(scope).textContent():null,collapse:!expected.done&&!expected.mode&&expected.collapse?await signature(scope.locator(collapseSelector).first()):null});}
async function open(page,file,interactive){await page.locator('#file-input').setInputFiles(file);await page.waitForFunction(flag=>S.words.length>0&&S.mode==='html'&&(flag?S.frame?.ready:!S.frame),interactive);}
try {
  browser=await chromium.launch();
  for(const viewport of [{width:1280,height:900},{width:390,height:844}])for(let index=0;index<files.length;index++){
    const file=files[index],strict=file.startsWith(fixtures+path.sep);
    const rawContext=await browser.newContext({viewport});const raw=await rawContext.newPage();await raw.goto(`${origin}/fixture/${index}`);
    const expected=await capabilities(raw);
    if(strict)for(const [key,count]of Object.entries(expected))assert(count>0,'Synthetic fixture lacks '+key);
    const panels=await raw.locator('[data-reading],.answer,.reveal,.a').evaluateAll(els=>els.map(el=>el.textContent.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,25));
    await rawContext.close();
    for(const interactive of [true,false]){
      checking = path.basename(file) + ' at ' + viewport.width + 'px / ' + (interactive ? 'Interactive' : 'read-only');
      const context=await browser.newContext({viewport,serviceWorkers:'block'});const errors=[];
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      await context.addInitScript(flag=>{localStorage.setItem('aloud.engine',JSON.stringify('device'));localStorage.setItem('aloud.htmlInteractive',JSON.stringify(flag));},interactive);
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await open(page,file,interactive);
      if(interactive){
        const frame=await page.locator('#content iframe').elementHandle().then(el=>el.contentFrame());assert(frame);
        await exercise(frame,expected);
        const before=await restoredSignature(frame,expected);
        // Verify actual parent-side shim state, not raw localStorage belonging to the file page.
        if(expected.done||expected.mode||expected.collapse){
          const snapshot=await frame.evaluate(()=>Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const key=localStorage.key(i);return[key,localStorage.getItem(key)];})));
          await page.waitForFunction(snapshot=>{const saved=store.get(S.frame.lsKey,{});return Object.keys(saved).length===Object.keys(snapshot).length&&Object.keys(snapshot).every(key=>Object.hasOwn(saved,key)&&saved[key]===snapshot[key]);},snapshot);
          const storage=await page.evaluate(()=>JSON.stringify(store.get(S.frame.lsKey,{})));assert(storage!=='{}');
          await page.locator('#btn-library').click();await page.reload();await page.locator('.rr-open').first().click();await page.waitForFunction(()=>S.frame?.ready);
          const reopened=await page.locator('#content iframe').elementHandle().then(el=>el.contentFrame());assert.equal(await restoredSignature(reopened,expected),before,'Guide UI did not restore saved state');assert.equal(await page.evaluate(()=>JSON.stringify(store.get(S.frame.lsKey,{}))),storage,'Shim state lost on reload/reopen');
        }
        const iframe=await page.locator('#content iframe').elementHandle();const code=await page.evaluate(()=>S.words.filter(w=>w.code).length);
        if(strict)assert(code>0,'Synthetic fixture must exercise Skip code');
        if(code){await page.evaluate(()=>{if(!S.skipCode)document.getElementById('skipcode-switch').click();document.getElementById('skipcode-switch').click();});assert(await page.evaluate(()=>S.words.some(w=>w.code&&!w.mute)));assert(await page.evaluate(el=>el===S.frame.el,iframe),'Skip code replaced the live frame');await page.evaluate(()=>document.getElementById('skipcode-switch').click());assert(await page.evaluate(()=>S.words.filter(w=>w.code).every(w=>w.mute)));}
        if(strict){const active=await iframe.contentFrame();const font=await active.locator('.body-copy').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));const player=await page.locator('#player').boundingBox();await page.locator('#zoom-in').click();await active.waitForFunction(before=>parseFloat(getComputedStyle(document.querySelector('.body-copy')).fontSize)>before,font);assert.equal((await page.locator('#player').boundingBox()).width,player.width,'Text zoom enlarged player chrome');}
      }else{
        assert.equal(await page.locator('#content iframe').count(),0);
        for(const text of panels)assert(await page.locator('.html-host').evaluate((host,text)=>[...host.shadowRoot.querySelectorAll('[data-reading],.answer,.reveal,.a')].some(el=>el.textContent.replace(/\s+/g,' ').trim()===text&&el.checkVisibility()),text),'Read-only lost or hid panel text');
        const fixed=await page.locator('.html-host').evaluate(host=>{const el=[...host.shadowRoot.querySelectorAll('*')].find(e=>getComputedStyle(e).position==='fixed');if(!el)return null;const f=el.getBoundingClientRect(),h=host.getBoundingClientRect();return{top:f.top,bottom:f.bottom,left:f.left,right:f.right,hostTop:h.top,hostRight:h.right};});
        if(fixed){assert(fixed.top>=fixed.hostTop-1&&fixed.right<=fixed.hostRight+1,'Read-only fixed control escaped document surface');}
        if(strict)assert(fixed,'Read-only fixture must check fixed containment');
        // Scripts intentionally do not run here: assert expanded content and usable Aloud controls instead.
        await page.locator('#btn-library').click();assert(await page.locator('.rr-open').count());
      }
      assert.deepEqual(errors,[],'Browser script errors');await context.close();
    }
    console.log(`PASS: ${path.basename(file)} at ${viewport.width}px — live widgets, shim persistence and read-only preservation`);
  }
}catch(error){
  console.error('Guide gate failed:', checking, error.name);
  if(!process.env.GUIDE_DIR)console.error(error.stack); // Never print private document content.
  process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
