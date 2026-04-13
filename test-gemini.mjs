import { fetchPageHtml, analyzeWithGemini } from './electron/ipc/gemini.js';

async function run() {
  try {
    console.log("Fetching eBay listing...");
    const url = "https://www.ebay.com/itm/404179782522"; // Random active eBay listing (usually a generic charger or phone)
    let html = "";
    try {
        html = await fetchPageHtml(url);
    } catch {
        html = await fetchPageHtml("https://www.ebay.com");
    }
    console.log(`Fetched HTML: ${html.length} chars`);
    
    console.log("Analyzing with Gemini...");
    const result = await analyzeWithGemini(html, url, 'ebay');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Test failed:", err);
  }
}

run();
