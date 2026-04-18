import { queueScrape } from './electron/ipc/browserPool.js';
import { POSHMARK_CONFIG, POSHMARK_SOLD_EXTRACTOR } from './electron/extractors/marketplace.js';

async function test() {
  const query = "iPhone 14 Pro 256GB";
  
  console.log("Testing Poshmark...");
  const url = `https://poshmark.com/search?query=${encodeURIComponent(query)}&availability=sold_out`;
  try {
    const res = await queueScrape(url, POSHMARK_SOLD_EXTRACTOR, POSHMARK_CONFIG);
    console.log(`Poshmark items: ${res.length}`);
    if (res.length > 0) {
      console.log('Sample:', res.slice(0, 2));
    }
  } catch(e) { console.error("Poshmark error:", e); }

  process.exit(0);
}

test();
