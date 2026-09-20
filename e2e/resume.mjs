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
console.log('localStorage resume:', await p.evaluate(()=>localStorage.getItem('fg.resume'))? 'present':'MISSING');

// Simulate CLOSING the tab: sessionStorage dies, localStorage survives.
await p.evaluate(()=>{ try { sessionStorage.clear(); } catch {} });
await p.goto('http://localhost:4123/',{waitUntil:'networkidle'});
await p.waitForTimeout(1500);
const body = await p.innerText('body');
const m = body.match(/You are still in room\s+([A-Z0-9]+)/);
console.log('rejoin banner:', m ? `"${m[0]}"` : 'NOT SHOWN');
console.log('matches original:', m ? m[1] === code : false);

// Expiry must be honoured.
await p.evaluate(()=>{ const r=JSON.parse(localStorage.getItem('fg.resume')); r.expiresAt = 1; localStorage.setItem('fg.resume', JSON.stringify(r)); });
await p.goto('http://localhost:4123/',{waitUntil:'networkidle'});
await p.waitForTimeout(1200);
console.log('after expiry, banner shown:', /You are still in room/.test(await p.innerText('body')));
await b.close();
