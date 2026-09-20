import { chromium } from 'playwright';
const URL = process.env.URL || 'https://golf-flax-six.vercel.app';
const b = await chromium.launch();
const c1 = await b.newContext(), c2 = await b.newContext();
await c2.addInitScript(() => {
  window.__t0 = Date.now(); window.__marks = [];
  const mark = (m) => window.__marks.push(`${Date.now()-window.__t0}ms ${m}`);
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(u, ...r){ super(u, ...r); const host=String(u).slice(0,38);
      mark(`ws open-attempt ${host}`);
      this.addEventListener('open', ()=>mark(`ws OPEN ${host}`));
      this.addEventListener('error', ()=>mark(`ws ERR ${host}`));
      this.addEventListener('close', ()=>mark(`ws CLOSE ${host}`)); }
  };
  const RTC = window.RTCPeerConnection;
  if (RTC) window.RTCPeerConnection = class extends RTC {
    constructor(...a){ super(...a); mark('rtc created');
      this.addEventListener('connectionstatechange', ()=>mark('rtc '+this.connectionState)); }
  };
});
const host = await c1.newPage(), guest = await c2.newPage();
await host.goto(URL, {waitUntil:'networkidle'}); await host.waitForTimeout(700);
await host.getByText(/^Play Together$/).first().click();
await host.waitForURL(/\/room/,{timeout:30000}).catch(()=>{});
await host.waitForTimeout(3000);
const code = new global.URL(host.url()).searchParams.get('code');

const tNav = Date.now();
await guest.goto(`${URL}/room/?code=${code}`, {waitUntil:'domcontentloaded'});
const tLoaded = Date.now();
await guest.waitForTimeout(1200);
const jb = guest.getByRole('button',{name:/^join the room$/i}).first();
if (await jb.count()) await jb.click();
const tClick = Date.now();
let ok=false;
for (let i=0;i<120 && !ok;i++){ await guest.waitForTimeout(250); ok=/2\s*\/\s*8/.test(await host.innerText('body')); }
const tJoined = Date.now();
console.log(`page load      : ${tLoaded-tNav}ms`);
console.log(`click -> joined: ${tJoined-tClick}ms`);
console.log('guest timeline:');
console.log((await guest.evaluate(()=>window.__marks)).slice(0,22).map(m=>'  '+m).join('\n'));
await b.close();
