import assert from 'node:assert/strict';

// Use the same passage in all views. Printing it produces a real PDF with
// selectable text and fixed line breaks for the PDF.js text-layer check.
export async function checkCenteredSpritz(browser, origin) {
  const sentence = 'A silver waterline traces the old stone steps down to the landing and across the weathered harbor wall.';
  const paragraphs = ['The morning tide has turned.', sentence, 'Another step appears.'];
  const html = '<style>p{max-width:18em;font:18px/1.5 Georgia}</style>' + paragraphs.map(p => '<p>' + p + '</p>').join('');
  const printPage = await browser.newPage();
  await printPage.setContent(html);
  const pdf = await printPage.pdf({format: 'A5'});
  await printPage.close();

  for (const viewport of [{width: 1024, height: 768}, {width: 390, height: 844}]) {
    const context = await browser.newContext({viewport, reducedMotion: 'reduce'});
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    try {
      await page.goto(origin);
      for (const mode of ['flow', 'pdf', 'interactive', 'readonly']) {
        await page.evaluate(mode => {
          S.pdfViewPref = 'pdf';
          S.htmlInteractive = mode === 'interactive';
        }, mode);
        const type = mode === 'flow' ? 'txt' : mode === 'pdf' ? 'pdf' : 'html';
        const buffer = type === 'pdf' ? pdf : Buffer.from(type === 'txt' ? paragraphs.join('\n\n') : html);
        const name = 'Tide ' + mode + '.' + type;
        await page.locator('#file-input').setInputFiles({name, mimeType: {txt:'text/plain',pdf:'application/pdf',html:'text/html'}[type], buffer});
        await page.waitForFunction(({name, mode}) => S.docTitle === name.slice(0, name.lastIndexOf('.')) && S.words.length &&
          (mode === 'interactive' ? S.frame?.ready : mode === 'readonly' ? S.mode === 'html' && !S.frame : S.mode === mode), {name, mode});

        await page.evaluate(() => {
          if (!S.rsvp.centered) $('centered-spritz-switch').click();
          if (!S.rsvp.open) setRsvpOpen(true);
        });
        await page.waitForTimeout(420); // Allow the player's existing open transition to finish.
        const active = mode === 'interactive' ? await (await page.locator('#content iframe').elementHandle()).contentFrame() : page;
        const indices = await page.evaluate(() => [0, S.words.findIndex(w => w.text === 'waterline'), S.words.length-1]);
        for (const index of indices) {
          assert(index >= 0);
          await page.evaluate(i => seekSentence(S.words[i].sent, false, i), index);
          const deadline = Date.now() + 4000;
          let geometry;
          do {
            const highlight = await active.locator('.sent-active,.sent-on').evaluateAll(els => {
              const rects = els.map(el => el.getBoundingClientRect()).filter(r => r.height && r.width);
              return {top:Math.min(...rects.map(r=>r.top)), bottom:Math.max(...rects.map(r=>r.bottom))};
            });
            const frameTop = mode === 'interactive' ? (await page.locator('#content iframe').boundingBox()).y : 0;
            geometry = await page.evaluate(({highlight,frameTop}) => {
              const card = $('rsvp-float').getBoundingClientRect(), pivot = $('rsvp-orp').getBoundingClientRect();
              return {gap:card.top-frameTop-highlight.bottom, top:frameTop+highlight.top, toolbar:$('topbar').getBoundingClientRect().bottom,
                dx:Math.abs(pivot.left+pivot.width/2-innerWidth/2), dy:Math.abs(card.top+card.height/2-innerHeight/2)};
            }, {highlight,frameTop});
            if (Math.abs(geometry.gap-14)<2 && geometry.top>=geometry.toolbar-1) break;
            await page.waitForTimeout(30);
          } while (Date.now()<deadline);
          assert(Math.abs(geometry.gap-14)<2 && geometry.top>=geometry.toolbar-1 &&
            geometry.dx<1 && geometry.dy<1, mode+' at '+viewport.width+' word '+index+': '+JSON.stringify(geometry));
        }
        await page.evaluate(() => setRsvpOpen(false));
        assert.equal(await page.locator('#rsvp-word').evaluate(el=>el.parentElement.id),'rsvp-body');
        await page.reload();
        assert.equal(await page.locator('#centered-spritz-switch').getAttribute('aria-checked'),'true');
      }
    } finally { await context.close(); }
  }
}
