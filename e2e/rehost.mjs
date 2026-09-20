import { chromium } from 'playwright';
const b=await chromium.launch();
const ctx=await b.newContext();
const p=await ctx.newPage();
await p.goto('http://localhost:4123/',{waitUntil:'domcontentloaded'});
await p.evaluate(()=>{try{sessionStorage.clear();localStorage.clear();}catch{}});
await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(600);
await p.getByText(/^Play Together$/).first().click();
await p.waitForURL(/\/room/,{timeout:20000}).catch(()=>{});
await p.waitForTimeout(2500);
const code=new URL(p.url()).searchParams.get('code');
console.log('created room:', code);
console.log('HOST badge before reload:', /HOST/.test(await p.innerText('body')));
console.log('resume stored while only in LOBBY:', (await p.evaluate(()=>localStorage.getItem('fg.resume'))) ? 'yes (should be no)' : 'no (correct)');

// Reload into the same, now-empty room.
await p.reload({waitUntil:'networkidle'});
await p.waitForTimeout(12000);
const body = await p.innerText('body');
console.log('HOST badge after reload :', /HOST/.test(body));
console.log('still shows room code   :', new URL(p.url()).searchParams.get('code') === code);
await b.close();
