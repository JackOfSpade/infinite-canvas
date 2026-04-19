import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('https://www.ebay.com/sch/i.html?_nkw=iPhone%2014%20Pro%20256GB&LH_Complete=1&LH_Sold=1&_sop=13', { waitUntil: 'networkidle2' });
  const html = await page.content();
  console.log(html.substring(0, 500));
  console.log("Length:", html.length);
  const items = await page.$$('.s-item');
  console.log("s-items", items.length);
  await browser.close();
})();
