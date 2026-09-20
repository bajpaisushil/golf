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

const banner = async p => ((await p.innerText('body')).match(/(Take your shot|Your shot|Your turn|[A-Z][a-z]+ [A-Z][a-z]+ is putting|Waiting for [^\n]{0,26}|Next up)/)||['(none)'])[0];
const canAct = async p => (await p.locator('[role="application"][tabindex="0"]').count()) > 0;

console.log(`MODE=${MODE}`);
console.log('  host  banner:', await banner(host), '| controls live:', await canAct(host));
console.log('  guest banner:', await banner(guest), '| controls live:', await canAct(guest));

// Putt from whoever is up.
const actor = (await canAct(host)) ? host : guest;
const tag = actor===host?'host':'guest';
const box = await actor.locator('canvas').first().boundingBox();
const x=box.x+box.width*0.4, y=box.y+box.height*0.5;
await actor.mouse.move(x,y); await actor.mouse.down();
await actor.mouse.move(x+16,y+120,{steps:14}); await actor.mouse.up();
await actor.waitForTimeout(7500);

console.log(`  after ${tag} putt:`);
console.log('    host  banner:', await banner(host), '| controls live:', await canAct(host));
console.log('    guest banner:', await banner(guest), '| controls live:', await canAct(guest));
await host.screenshot({path:`${S}/11-${MODE}-after.png`});
console.log('  errors:', JSON.stringify([...new Set(errs)]).slice(0,240));
await b.close();
