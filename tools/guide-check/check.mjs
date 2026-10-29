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
  // A fixed guide control is visible in its tall iframe even when the outer
  // reader is scrolled away. Bring that frame's top below Aloud's toolbar;
  // keep a real pointer click so an actually obstructed control still fails.
  if (await locator.evaluate(el => getComputedStyle(el).position === 'fixed')) {
    const handle = await locator.elementHandle(), frame = await handle.ownerFrame();
    await handle.dispose();
    if (frame.parentFrame()) {
      const host = await frame.frameElement();
      await host.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - (document.getElementById('topbar')?.getBoundingClientRect().bottom || 0) - 16, behavior: 'instant' }));
      await host.dispose();
    }
  }
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
async function checkPlayer(page, viewport) {
  const centered = async () => assert(await page.evaluate(() => {
    const p = $('player').getBoundingClientRect(), b = $('btn-play').getBoundingClientRect();
    return Math.abs(b.left + b.width / 2 - p.left - p.width / 2) < 1;
  }), 'Play/Pause is off center');
  await centered();
  if (viewport.width <= 560) {
    assert(!await page.locator('#btn-speed').isVisible(), 'Phone player should start compact');
    await page.locator('#btn-player-details').click();
    assert(await page.locator('#btn-speed').isVisible());
    await centered();
    await page.locator('#btn-speed').click();
    assert.equal(await page.locator('#speed-sheet').getAttribute('aria-hidden'), 'false');
    await page.locator('#speed-chips button').filter({hasText: /^2×$/}).click();
    assert.equal(await page.locator('#player-rate').textContent(), '2×');
    await page.locator('#speed-sheet .sheet-close').click();
    await page.locator('#btn-player-details').click();
    await page.locator('#btn-player-rsvp').click();
    assert.equal(await page.locator('#btn-player-rsvp').getAttribute('aria-pressed'), 'true');
    await page.locator('#rsvp-close').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-player-rsvp');
    await centered();
  }
}
async function checkLibraryLayout(page) {
  await page.locator('#btn-library').click();
  await page.waitForFunction(() => document.activeElement === $('recent-list').querySelector('.rr-open'));
  await page.locator('#lib-newfolder').focus();
  await page.evaluate(() => renderRecents());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'lib-newfolder', 'Library refresh lost toolbar focus');
  assert.equal(await page.locator('#home h1').textContent(), 'Continue reading');
  assert(await page.evaluate(() => !!($('library').compareDocumentPosition($('dropzone')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'Import area still precedes Library');
  const title = page.locator('#recent-list .rr-name').first();
  assert.equal(await title.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
  await page.locator('.rr-open').first().click();
  await page.waitForFunction(() => S.frame?.ready);
}
async function checkPanels(page, viewport) {
  const settings = async () => {
    if (viewport.width <= 1100) await page.locator('#btn-more').click();
    await page.locator('#btn-settings').click();
  };
  const snapshot = await page.evaluate(() => JSON.stringify(S.words.map(w => [w.text, !!w.mute])));
  await settings();
  assert.match(await page.locator('#settings-view-context').textContent(), /Original HTML/);
  assert(await page.locator('#bold-switch').isDisabled(), 'Original layout offered ineffective Bold control');
  assert(!await page.locator('#font-select').isDisabled(), 'Original layout lost Speed reader font selection');
  assert(!await page.locator('#smallprint-row').isVisible(), 'Non-PDF view shows PDF-only controls');
  await page.locator('#skipcit-switch').click();
  assert.match(await page.locator('#speech-summary').textContent(), /Source citations: read/);
  await page.locator('#skipcit-switch').click();
  assert.match(await page.locator('#speech-summary').textContent(), /Source citations: skipped/);
  assert.equal(await page.evaluate(() => JSON.stringify(S.words.map(w => [w.text, !!w.mute]))), snapshot, 'Panel interactions changed speech exclusions');
  await page.locator('#settings-sheet .sheet-close').click();
  if (viewport.width <= 560) await page.locator('#btn-player-details').click();
  await page.locator('#btn-speed').click();
  assert(!await page.locator('#lag-chips').isVisible(), 'Timing controls should start folded');
  const summary = page.locator('#highlight-timing summary');
  await summary.focus(); await summary.press('Enter');
  assert(await page.locator('#lag-chips').isVisible(), 'Timing disclosure is not keyboard operable');
  await page.locator('#lag-chips button').filter({hasText: /^160 ms$/}).click();
  assert.equal(await page.locator('#lag-summary').textContent(), '160 ms');
  for (const rate of [2, 3]) {
    await page.locator('#speed-chips button').filter({hasText: new RegExp('^' + rate + '×$')}).click();
    assert.equal(await page.evaluate(() => S.rate), rate);
    assert(await page.locator('#highlight-timing').getAttribute('open') !== null, 'Changing speed closed timing controls');
  }
  await page.locator('#lag-chip-auto').click();
  await page.locator('#speed-sheet .sheet-close').click();
  await page.locator('#btn-view').click(); await page.locator('#view-reading').click();
  await page.waitForFunction(() => S.mode === 'flow' && S.words.length > 0);
  await settings();
  assert.equal(await page.locator('#settings-view-context').textContent(), 'Reading view');
  assert(!await page.locator('#bold-switch').isDisabled());
  await page.locator('#bold-switch').click();
  assert(await page.locator('#content').evaluate(el => el.classList.contains('bold-all')));
  await page.locator('#settings-sheet .sheet-close').click();
  await page.locator('#btn-view').click(); await page.locator('#view-original').click();
  await page.waitForFunction(() => S.frame?.ready);
  await settings();
  assert(await page.locator('#bold-switch').isDisabled());
  assert.equal(await page.locator('#bold-switch').getAttribute('aria-checked'), 'true', 'View changes discarded Bold preference');
  await page.locator('#settings-sheet .sheet-close').click();
}
async function checkSpritz(page, viewport) {
  await page.evaluate(() => setRsvpOpen(true));
  await page.waitForFunction(() => fitRsvpWord.metrics?.width === $('rsvp-word').clientWidth);
  const reads = await page.evaluate(() => {
    rsvpFlash('Ready');
    const computed = window.getComputedStyle, width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    let fonts = 0, widths = 0;
    window.getComputedStyle = (el, ...args) => { if (el.id === 'rsvp-word') fonts++; return computed(el, ...args); };
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { if (this.id === 'rsvp-word') widths++; return width.get.call(this); } });
    try {
      for (let i = 0; i < 100; i++) rsvpFlash(i % 2 ? 'short' : 'a-much-longer-token');
      return { fonts, widths };
    } finally {
      window.getComputedStyle = computed;
      Object.defineProperty(Element.prototype, 'clientWidth', width);
    }
  });
  assert.deepEqual(reads, { fonts: 0, widths: 0 }, 'Spritz reads layout/font on each word');
  await page.selectOption('#font-select', 'mono');
  assert(await page.evaluate(() => fitRsvpWord.metrics.font.includes('monospace')), 'Spritz ignored a font change');
  const width = viewport.width === 390 ? 1280 : 390;
  await page.setViewportSize({ width, height: viewport.height });
  await page.waitForFunction(() => fitRsvpWord.metrics?.width === $('rsvp-word').clientWidth);
  await page.evaluate(() => rsvpFlash('pneumonoultramicroscopicsilicovolcanoconiosis'));
  assert(await page.evaluate(() => {
    const box = $('rsvp-word').getBoundingClientRect();
    return ['rsvp-pre','rsvp-orp','rsvp-post'].every(id => {
      const r = $(id).getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1;
    });
  }), 'Long Spritz word escaped the resized display');
  await page.setViewportSize(viewport);
  await page.selectOption('#font-select', 'serif');
  await page.evaluate(() => setRsvpOpen(false));
}
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
      const context=await browser.newContext({viewport});const errors=[];
      await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&url.pathname!=='/sw.js'?route.continue():route.abort();});
      await context.addInitScript(flag=>{if(window!==window.top)return;try{localStorage.setItem('aloud.engine',JSON.stringify('device'));localStorage.setItem('aloud.htmlInteractive',JSON.stringify(flag));}catch{}},interactive);
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
        if(strict){
          await checkPlayer(page, viewport);
          const active=await iframe.contentFrame();
          assert.equal(await active.locator('.examline span').count(), 1, 'Word wrappers matched authored span selectors');
          assert(await active.locator('.examline .aloud-w').first().evaluate(el => getComputedStyle(el).borderTopWidth === '0px'), 'A word became a bordered badge');
          assert(await active.locator('svg .aloud-w').evaluateAll(els => els.length > 0 && els.every(el => el.namespaceURI === 'http://www.w3.org/2000/svg')), 'SVG label namespace changed');
          const font=await active.locator('.body-copy').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));const player=await page.locator('#player').boundingBox();if(viewport.width <= 699)await page.locator('#btn-view').click();await page.locator('#zoom-in').click();if(viewport.width <= 699)await page.locator('#view-sheet .sheet-close').click();await active.waitForFunction(before=>parseFloat(getComputedStyle(document.querySelector('.body-copy')).fontSize)>before,font);assert.equal((await page.locator('#player').boundingBox()).width,player.width,'Text zoom enlarged player chrome');}
        if(strict) { await checkSpritz(page, viewport); await checkLibraryLayout(page); await checkPanels(page, viewport); }
      }else{
        assert.equal(await page.locator('#content iframe').count(),0);
        for(const text of panels)assert(await page.locator('.html-host').evaluate((host,text)=>[...host.shadowRoot.querySelectorAll('[data-reading],.answer,.reveal,.a')].some(el=>el.textContent.replace(/\s+/g,' ').trim()===text&&el.checkVisibility()),text),'Read-only lost or hid panel text');
        const fixed=await page.locator('.html-host').evaluate(host=>{const el=[...host.shadowRoot.querySelectorAll('*')].find(e=>getComputedStyle(e).position==='fixed');if(!el)return null;const f=el.getBoundingClientRect(),h=host.getBoundingClientRect();return{top:f.top,bottom:f.bottom,left:f.left,right:f.right,hostTop:h.top,hostRight:h.right};});
        if(fixed){assert(fixed.top>=fixed.hostTop-1&&fixed.right<=fixed.hostRight+1,'Read-only fixed control escaped document surface');}
        if(strict)assert(fixed,'Read-only fixture must check fixed containment');
        if(strict){assert.equal(await page.locator('.html-host').evaluate(host=>host.shadowRoot.querySelectorAll('.examline span').length),1,'Read-only wrappers matched authored span selectors');}
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
