// Cross-DEVICE simulation against the deployed site.
// Two separate browser CONTEXTS do not share a BroadcastChannel, so this forces
// the handshake through the public Nostr relays — the real remote-player path.
import { chromium } from 'playwright';
const URL = process.env.URL || 'https://golf-flax-six.vercel.app';
const b = await chromium.launch();
const c1 = await b.newContext({viewport:{width:1100,height:820}});
const c2 = await b.newContext({viewport:{width:1100,height:820}});
const host = await c1.newPage(), guest = await c2.newPage();
const t0 = Date.now();
await host.goto(URL, {waitUntil:'networkidle'});
await host.waitForTimeout(800);
await host.getByText(/^Friend Battle$/).first().click();
await host.waitForURL(/\/room/, {timeout:30000}).catch(()=>{});
await host.waitForTimeout(3000);
const code = new URL_(host.url()).searchParams.get('code');
function URL_(u){ return new global.URL(u); }
console.log('room code:', code, `(created in ${Date.now()-t0}ms)`);

const tJoin = Date.now();
await guest.goto(`${URL}/room/?code=${code}`, {waitUntil:'networkidle'});
await guest.waitForTimeout(1500);
const jb = guest.getByRole('button',{name:/^join the room$/i}).first();
if (await jb.count()) await jb.click();

// Wait for the roster to actually show 2 players on the HOST side.
let connected = false;
for (let i=0; i<40 && !connected; i++) {
  await host.waitForTimeout(1000);
  connected = /2\s*\/\s*8/.test(await host.innerText('body'));
}
console.log(connected ? `CONNECTED over public relays in ${Date.now()-tJoin}ms` : 'FAILED to connect in 40s');

if (connected) {
  await host.getByRole('button',{name:/start|begin|tee off/i}).first().click({force:true}).catch(()=>{});
  await host.waitForTimeout(6000);
  const box = await host.locator('canvas').first().boundingBox();
  const x=box.x+box.width*0.35, y=box.y+box.height*0.45;
  await host.mouse.move(x,y); await host.mouse.down();
  await host.mouse.move(x+20,y+140,{steps:16}); await host.mouse.up();
  await host.waitForTimeout(7000);
  const peer = await guest.innerText('body');
  console.log('peer sees host stroke:', /\b1 HITS?\b/.test(peer));
  await host.screenshot({path: (process.env.S||'.')+'/10-live-host.png'});
}
await b.close();
