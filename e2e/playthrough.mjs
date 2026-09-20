// Plays a whole round by repeatedly putting from whoever is on turn, using
// keyboard aiming (its default direction points at the hole).
import { chromium } from 'playwright';
const S=process.env.S, MODE=process.env.MODE||'together';
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1280,height:860}});
const errs=[];
const mk=async t=>{const p=await ctx.newPage();
  p.on('pageerror',e=>errs.push(`[${t}] ${e.message}`.slice(0,180)));return p;};
const host=await mk('host'), guest=await mk('guest');
await host.goto('http://localhost:4123/',{waitUntil:'domcontentloaded'});
await host.evaluate(()=>{try{sessionStorage.clear();localStorage.clear();}catch{}});
await host.reload({waitUntil:'networkidle'}); await host.waitForTimeout(600);
await host.getByText(MODE==='battle'?/^Friend Battle$/:/^Play Together$/).first().click();
await host.waitForURL(/\/room/,{timeout:20000}).catch(()=>{});
await host.waitForTimeout(2500);
const code=new URL(host.url()).searchParams.get('code');
await guest.goto(`http://localhost:4123/room/?code=${code}`,{waitUntil:'networkidle'});
await guest.waitForTimeout(1500);
const jb=guest.getByRole('button',{name:/^join the room$/i}).first();
if(await jb.count()) await jb.click();
await guest.waitForTimeout(4000);
await host.getByRole('button',{name:/start|begin|tee off/i}).first().click({force:true}).catch(()=>{});
await host.waitForTimeout(5000);

const live = async p => (await p.locator('[role="application"][tabindex="0"]').count()) > 0;
let done=false;
for (let i=0; i<22 && !done; i++) {
  const actor = (await live(host)) ? host : (await live(guest)) ? guest : null;
  if (actor === null) { await host.waitForTimeout(1200); }
  else {
    const stage = actor.locator('[role="application"]').first();
    await stage.focus().catch(()=>{});
    for (let k=0;k<4;k++){ await stage.press('ArrowUp').catch(()=>{}); await actor.waitForTimeout(50); }
    await stage.press('Enter').catch(()=>{});
    await actor.waitForTimeout(5200);
  }
  const t = await host.innerText('body');
  if (/ROUND \d+ COMPLETE|COMPLETE|Together:|Everyone reached/i.test(t)) {
    done = true;
    console.log('ROUND COMPLETED after', i+1, 'putts');
    console.log(t.replace(/\n{2,}/g,' | ').slice(0,420));
    await host.screenshot({path:`${S}/12-${MODE}-summary.png`});
  }
}
if(!done) console.log('round did not complete in 22 putts; last host text:', (await host.innerText('body')).replace(/\n{2,}/g,' | ').slice(0,260));
console.log('errors:', JSON.stringify([...new Set(errs)]).slice(0,240));
await b.close();
