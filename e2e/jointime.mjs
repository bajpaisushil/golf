import { chromium } from 'playwright';
const b=await chromium.launch();
const ctx=await b.newContext();
const host=await ctx.newPage(), guest=await ctx.newPage();
await host.goto('http://localhost:4123/',{waitUntil:'domcontentloaded'});
await host.evaluate(()=>{try{sessionStorage.clear();localStorage.clear();}catch{}});
await host.reload({waitUntil:'networkidle'}); await host.waitForTimeout(600);
await host.getByText(/^Play Together$/).first().click();
await host.waitForURL(/\/room/,{timeout:20000}).catch(()=>{});
await host.waitForTimeout(2500);
const code=new URL(host.url()).searchParams.get('code');
const t0=Date.now();
await guest.goto(`http://localhost:4123/room/?code=${code}`,{waitUntil:'networkidle'});
await guest.waitForTimeout(1200);
const jb=guest.getByRole('button',{name:/^join the room$/i}).first();
if(await jb.count()) await jb.click();
const tClick=Date.now();
let ok=false;
for(let i=0;i<60 && !ok;i++){
  await host.waitForTimeout(500);
  ok=/2\s*\/\s*8/.test(await host.innerText('body'));
}
console.log(ok ? `JOINED in ${Date.now()-tClick}ms after clicking join (${Date.now()-t0}ms from navigation)` : 'NEVER JOINED in 30s');
await b.close();
