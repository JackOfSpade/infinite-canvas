import { queueScrape } from './electron/ipc/browserPool.js';

async function test() {
  const url = "https://www.ebay.com/sch/i.html?_nkw=iPhone+14+Pro+256GB&LH_Complete=1&LH_Sold=1&_sop=13";
  const extractor = `
    (function(){
      return {
        hasBody: !!document.body,
        bodyLength: document.body ? document.body.innerHTML.length : 0,
        sItemCount: document.querySelectorAll('.s-item').length,
        text: document.body.innerText.substring(0, 500)
      };
    })()
  `;
  try {
    const res = await queueScrape(url, extractor, { waitMs: 2000 });
    console.log("eBay Result:", res);
  } catch(e) { console.error(e); }
  process.exit(0);
}
test();
