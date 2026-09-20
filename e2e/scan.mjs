import { chromium } from 'playwright';
const S=process.env.S;
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1280,height:860}});
const errs=[];
const mk=async t=>{const p=await ctx.newPage();
  p.on('pageerror',e=>errs.push(`[${t}] ${e.message}`.slice(0,200)));return p;};
const host=await mk('host'), guest=await mk('guest');
await host.goto('http://localhost:4123/',{waitUntil:'domcontentloaded'});
await host.evaluate(()=>{try{sessionStorage.clear();localStorage.clear();}catch{}});
await host.reload({waitUntil:'networkidle'}); await host.waitForTimeout(600);
const MODE=process.env.MODE||'together';
await host.getByText(MODE==='together'?/^Play Together$/:/^Friend Battle$/).first().click();
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

console.log('HOST banner:', ((await host.innerText('body')).match(/(Your turn|Waiting for [^\n]{0,30}|[^\n]{0,24}still putting[^\n]{0,10})/)||[''])[0]);
console.log('GUEST banner:', ((await guest.innerText('body')).match(/(Your turn|Waiting for [^\n]{0,30}|[^\n]{0,24}still putting[^\n]{0,10})/)||[''])[0]);
const actor = (await host.innerText('body')).includes('Your turn') || MODE==='battle' ? host : guest;
const hits = async p => (await p.innerText('body')).match(/(\d+)\s*HITS?\b/)?.[1] ?? '?';
console.log('start hits:', await hits(actor));

const box = await actor.locator('canvas').first().boundingBox();
let hit=false;
outer:
for (let ry=0.3; ry<=0.95 && !hit; ry+=0.13) {
  for (let rx=0.2; rx<=0.85 && !hit; rx+=0.16) {
    const x = box.x+box.width*rx, y = box.y+box.height*ry;
    await actor.mouse.move(x,y);
    await actor.mouse.down();
    await actor.mouse.move(x+4, y+90, {steps:8});
    // Did an aiming state actually engage?
    const aiming = await actor.evaluate(()=>document.body.innerText).then(t=>/POWER|Release|%/.test(t));
    await actor.mouse.up();
    await actor.waitForTimeout(900);
    const h = await hits(actor);
    if (aiming || (h!=='0' && h!=='?')) {
      console.log(`GRABBED at rx=${rx.toFixed(2)} ry=${ry.toFixed(2)} aimingUI=${aiming} hits=${h}`);
      hit=true; break outer;
    }
  }
}
if(!hit) console.log('NO GRAB ANYWHERE on the canvas — pointer aiming is broken');
console.log('final hits:', await hits(actor), 'errors:', JSON.stringify(errs).slice(0,300));
await b.close();
