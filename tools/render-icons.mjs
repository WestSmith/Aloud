/* Regenerate web/native PNGs from the same vector mark used in the header.
   Uses the existing guide-check Chromium; no new app/build dependency. */
import { chromium } from './guide-check/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const mark = await fs.readFile(new URL('assets/aloud-mark.svg', root), 'utf8');
const htmlPath = new URL('index.html', root), html = await fs.readFile(htmlPath, 'utf8');
const header = /(<div class="logo"><span class="dot">)[\s\S]*?(<\/span><span id="logo-text">)/;
if (!header.test(html)) throw new Error('Header mark target is missing');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [file, size, square] of [
    ['icon-192.png',192,false], ['icon-512.png',512,false],
    ['icon-maskable.png',512,true], ['apple-touch-icon.png',180,true],
    ['ios/Aloud.swiftpm/Resources/Assets.xcassets/AppIcon.appiconset/Aloud-AppIcon-1024.png',1024,true],
  ]) {
    await page.setViewportSize({width:size,height:size});
    await page.setContent('<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>' + (square ? mark.replace('rx="14"','rx="0"') : mark));
    await page.screenshot({path:new URL(file,root).pathname,omitBackground:true});
  }
  const updated = html.replace(header, (_, before, after) => before + mark.replace('<svg xmlns=', '<svg aria-hidden="true" xmlns=') + after);
  if (updated !== html) await fs.writeFile(htmlPath, updated);
} finally { await browser.close(); }
