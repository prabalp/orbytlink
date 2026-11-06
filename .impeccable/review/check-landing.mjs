import { chromium } from '@playwright/test';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:8080');
await page.evaluate(()=>document.fonts.ready);
if(process.argv.includes('--trust-only')) {
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const width of [1440,1000,768,390]){
  await page.setViewportSize({width,height:1000});
  await page.locator('#trust').evaluate(el=>scrollTo({top:el.getBoundingClientRect().top+scrollY-100,behavior:'instant'}));
  await page.waitForTimeout(300);
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Overflow '+width);
  await page.locator('#trust').screenshot({path:`/tmp/orbytlink-trust-${width}.png`});
 }
 console.log(JSON.stringify({viewports:[1440,1000,768,390],errors}));await browser.close();process.exit(errors.length?1:0);
}
if(process.argv.includes('--motion-only')) {
 await page.locator('#workflow-player').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>document.querySelector('#workflow-player').ready,{timeout:20000});
 const player=page.locator('#workflow-player');
 await player.evaluate(el=>el.pause());
 for(const time of [2,7,13]){
  await player.evaluate((el,t)=>el.seek(t),time);await page.waitForTimeout(500);
  await page.locator('#how').screenshot({path:`/tmp/orbytlink-motion-${time}.png`});
 }
 await page.locator('#motion-replay').click();await page.waitForTimeout(900);
 if(await player.evaluate(el=>el.paused||el.currentTime<.1))throw Error('Replay failed');
 await page.locator('#motion-toggle').click();if(!await player.evaluate(el=>el.paused))throw Error('Pause failed');
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:900});
  if(await page.locator('.how-visual').evaluate(el=>getComputedStyle(el).position)!=='static')throw Error('Sticky remains');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Overflow '+width);
  if(width===390)await page.locator('#how').screenshot({path:'/tmp/orbytlink-motion-mobile.png'});
 }
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(300);
 if(!await player.evaluate(el=>el.paused))throw Error('Reduced motion failed');
 console.log(JSON.stringify({ready:true,errors,duration:await player.evaluate(el=>el.duration)}));
 await browser.close();process.exit(errors.length?1:0);
}
if(process.argv.includes('--software-only')) {
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const width of [1440,1000,768,390]){
  await page.setViewportSize({width,height:1000});
  await page.locator('#software').evaluate(el=>scrollTo({top:el.getBoundingClientRect().top+scrollY-100,behavior:'instant'}));
  await page.waitForTimeout(350);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw Error('Overflow at '+width);
  await page.locator('#software').screenshot({path:`/tmp/orbytlink-software-${width}.png`});
 }
 if(await page.locator('#software s, #software .sw-replaces').count())throw Error('Old tags remain');
 console.log(JSON.stringify({viewports:[1440,1000,768,390],errors}));
 await browser.close();process.exit(errors.length?1:0);
}
await page.screenshot({path:'/tmp/orbytlink-desktop.png',fullPage:true});
await page.screenshot({path:'/tmp/orbytlink-hero.png'});
await page.locator('#demo-toggle').click();
if(await page.locator('#demo-label').textContent()!=='WHAT YOU KEEP')throw Error('Demo failed');
await page.locator('[data-file="sk"]').click();
if(!await page.locator('#file-sk').isVisible())throw Error('File tabs failed');
await page.locator('#signup button').click();
if(!await page.locator('#signup-note').evaluate(el=>el.classList.contains('err')))throw Error('Validation failed');
await page.locator('#theme').click();
await page.waitForTimeout(650);await page.screenshot({path:'/tmp/orbytlink-dark.png',fullPage:true});
await page.locator('#theme').click();
for(const width of [390,768,1440]){
 await page.setViewportSize({width,height:844});
 await page.goto('http://127.0.0.1:8080');
 await page.evaluate(()=>document.fonts.ready);
 const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,els:[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(el).position!=='absolute').slice(0,15).map(el=>el.className)}));
 console.log(JSON.stringify({viewport:width,...overflow}));
 if(width===390){await page.locator('#how').scrollIntoViewIfNeeded();await page.waitForTimeout(1000);await page.screenshot({path:'/tmp/orbytlink-mobile-how.png'});await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(500);await page.screenshot({path:'/tmp/orbytlink-mobile.png',fullPage:true});await page.screenshot({path:'/tmp/orbytlink-mobile-hero.png'});await page.locator('#menu').click();if(await page.locator('#menu').getAttribute('aria-expanded')!=='true')throw Error('Menu failed');await page.keyboard.press('Escape');}
}
console.log(JSON.stringify({errors}));
await browser.close();
if(errors.length)process.exitCode=1;
