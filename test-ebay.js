import { queueScrape } from './electron/ipc/browserPool.js';
import fs from 'fs';

async function test() {
  const url = "https://www.ebay.com/sch/i.html?_nkw=iPhone+14+Pro+256GB&LH_Complete=1&LH_Sold=1&_sop=13";
  const extractor = `
    (function(){
      return {
        hasSrp: !!document.querySelector('.srp-results'),
        srpHtml: document.querySelector('.srp-results') ? document.querySelector('.srp-results').innerHTML : '',
        bodyHtml: document.body.innerHTML
      };
    })()
  `;
  try {
    const res = await queueScrape(url, extractor, { waitMs: 2000 });
    fs.writeFileSync('ebay-body.html', res.bodyHtml);
    console.log("eBay Result: hasSrp =", res.hasSrp, "srp length =", res.srpHtml.length);
  } catch(e) { console.error(e); }
  process.exit(0);
}
test();
