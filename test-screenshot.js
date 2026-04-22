import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-gray-900 p-20 flex flex-col gap-10 justify-center items-center">
      <div class="w-[380px] bg-black/50 p-6 flex flex-col items-center gap-4">
        <h1 class="text-white">With h-10</h1>
        <audio controls class="w-full h-10 outline-none shrink-0" src="https://www.w3schools.com/html/horse.ogg"></audio>
      </div>
      <div class="w-[380px] bg-black/50 p-6 flex flex-col items-center gap-4">
        <h1 class="text-white">Without h-10 (default height)</h1>
        <audio controls class="w-full outline-none shrink-0" src="https://www.w3schools.com/html/horse.ogg"></audio>
      </div>
    </body>
    </html>
  `);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-audio.png' });
  await browser.close();
})();
