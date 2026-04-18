import { queueScrape } from './electron/ipc/browserPool.js';
import { 
  EBAY_SOLD_CONFIG, EBAY_SOLD_EXTRACTOR,
  EBAY_ACTIVE_CONFIG, EBAY_ACTIVE_EXTRACTOR,
  MERCARI_CONFIG, MERCARI_SOLD_EXTRACTOR,
} from './electron/extractors/marketplace.js';

async function test() {
  const query = "iPhone 14 Pro 256GB";
  
  console.log("Testing eBay...");
  const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`;
  try {
    const res = await queueScrape(ebayUrl, EBAY_SOLD_EXTRACTOR, EBAY_SOLD_CONFIG);
    console.log(`eBay items: ${res.length}`);
    if (res.length > 0) {
      console.log('Sample:', res.slice(0, 2));
    }
  } catch(e) { console.error("eBay error:", e); }

  console.log("Testing Mercari...");
  const mercariUrl = `https://www.mercari.com/search/?keyword=${encodeURIComponent(query)}`;
  try {
    const res = await queueScrape(mercariUrl, MERCARI_SOLD_EXTRACTOR, MERCARI_CONFIG);
    console.log(`Mercari items: ${res.length}`);
    if (res.length > 0) {
      console.log('Sample:', res.slice(0, 2));
    }
  } catch(e) { console.error("Mercari error:", e); }

  process.exit(0);
}

test();
