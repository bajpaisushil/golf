import { chromium } from 'playwright';
const S = process.env.S, MODE = process.env.MODE || 'together';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const log = [];
const mk = async (tag) => {
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type()==='error') log.push(`[${tag}] ${m.text()}`.slice(0,200)); });
  p.on('pageerror', e => log.push(`[${tag}] PAGEERROR ${e.message}`.slice(0,300)));
  return p;
};
const shot = async (p,n) => p.screenshot({ path: `${S}/${n}.png` });
const host = await mk('host'), guest = await mk('guest');

// --- host creates a room ---------------------------------------------------
await host.goto('http://localhost:4123/', { waitUntil: 'domcontentloaded' });
await host.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
await host.reload({ waitUntil: 'networkidle' });
await host.waitForTimeout(600);
await host.getByText(MODE==='together' ? /^Play Together$/ : /^Friend Battle$/).first().click();
await host.waitForURL(/\/room/, { timeout: 20000 }).catch(()=>{});
await host.waitForTimeout(2500);
await shot(host,'03-host-lobby');
const url = host.url();
const code = new URL(url).searchParams.get('code');
console.log('ROOM URL:', url, '| CODE:', code);

// --- guest joins -----------------------------------------------------------
await guest.goto(`http://localhost:4123/room/?code=${code}`, { waitUntil: 'networkidle' });
await guest.waitForTimeout(2000);
const joinBtn = guest.getByRole('button', { name: /^join the room$/i }).first();
if (await joinBtn.count()) { await joinBtn.click(); }
await guest.waitForTimeout(5000);
await shot(guest,'04-guest-lobby');
console.log('GUEST TEXT:\n'+(await guest.innerText('body')).replace(/\n{2,}/g,'\n').slice(0,600));
console.log('HOST TEXT:\n'+(await host.innerText('body')).replace(/\n{2,}/g,'\n').slice(0,600));

// --- host starts the game --------------------------------------------------
const start = host.getByRole('button', { name: /start|begin|tee off|play/i }).first();
if (await start.count()) {
  await start.click({ force: true }).catch(()=>{});
  await host.waitForTimeout(6000);
}
await shot(host,'05-host-game');
await shot(guest,'06-guest-game');
console.log('HOST IN-GAME:\n'+(await host.innerText('body')).replace(/\n{2,}/g,'\n').slice(0,700));
console.log('CANVAS:', JSON.stringify(await host.$$eval('canvas', cs=>cs.map(c=>({w:c.width,h:c.height})))));
console.log('ERRORS:', JSON.stringify([...new Set(log)], null, 1).slice(0,2000));
await b.close();
