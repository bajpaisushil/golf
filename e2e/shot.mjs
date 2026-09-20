import { chromium } from 'playwright';
const S=process.env.S;
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1280,height:860}});
const errs=[];
const mk=async t=>{const p=await ctx.newPage();
  p.on('pageerror',e=>errs.push(`[${t}] ${e.message}`.slice(0,200)));
  p.on('console',m=>{if(m.type()==='error')errs.push(`[${t}] ${m.text()}`.slice(0,200));});return p;};
const host=await mk('host'), guest=await mk('guest');
await host.goto('http://localhost:4123/',{waitUntil:'domcontentloaded'});
await host.evaluate(()=>{try{sessionStorage.clear();localStorage.clear();}catch{}});
await host.reload({waitUntil:'networkidle'}); await host.waitForTimeout(600);
await host.getByText(/^Play Together$/).first().click();
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

const hitsOf = async p => (await p.innerText('body')).match(/(\d+)\s*HITS?\b/)?.[1] ?? '?';
console.log('before  host:', await hitsOf(host), ' guest sees:', await hitsOf(guest));

// Keyboard aiming: default direction already points at the hole, so raise the
// power a few notches and putt. Deterministic — no pixel hunting for the ball.
const other0 = async (tag,h,g) => (await (tag==='host'?g:h).innerText('body'));
const turnOf = async (p,tag) => {
  const t = await p.innerText('body');
  console.log(`${tag}: yourTurn=${t.includes('Your turn')} waiting=${/Waiting for/.test(t)} ` +
    `banner="${(t.match(/(Your turn|Waiting for [^\n]{0,24})/)||[''])[0]}"`);
};
await turnOf(host,'host '); await turnOf(guest,'guest');

// Try to putt from BOTH sides; only the player on turn has live controls.
for (const [tag,p] of [['host',host],['guest',guest]]) {
  const stage = p.locator('[role="application"]').first();
  if (await stage.count() === 0) { console.log(tag,'no stage'); continue; }
  await stage.focus().catch(()=>{});
  for (let i=0;i<6;i++){ await stage.press('ArrowUp').catch(()=>{}); await p.waitForTimeout(70); }
  await stage.press('Enter').catch(()=>{});
  await p.waitForTimeout(6500);
  console.log(`${tag} putt -> host=${await hitsOf(host)} guest=${await hitsOf(guest)}`);
  await p.screenshot({path:`${S}/08-${tag}-after-putt.png`});
  { const pv = await other0(tag,host,guest);
    console.log('PEER sees "1 HIT" for shooter:', /\b1 HITS?\b/.test(pv));
    console.log('PEER rail raw:', (pv.split('\n').filter(l=>/HITS?\b/.test(l)).join(' | ')).slice(0,200)); }
  console.log(`${tag} body: ` + (await p.innerText('body')).replace(/\n{2,}/g,' | ').slice(0,320));
  break;
}
console.log('final   host:', await hitsOf(host), ' guest:', await hitsOf(guest));
console.log('host rail :', ((await host.innerText('body')).match(/You[\s\S]{0,40}HITS/)||[''])[0].replace(/\n/g,' '));
console.log('guest rail:', ((await guest.innerText('body')).match(/\d+ HITS[\s\S]{0,60}/)||[''])[0].replace(/\n/g,' '));
await host.screenshot({path:`${S}/07-after-shot.png`});
console.log('ERRORS:', JSON.stringify([...new Set(errs)]).slice(0,600));
await b.close();
