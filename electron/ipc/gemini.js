/**
 * Gemini AI service for marketplace listing analysis.
 * Fetches page HTML and sends it to Gemini for live interpretation.
 */

const GEMINI_API_KEY = 'AIzaSyDM49pnIwEAHt8FCAB0i2rP8MXFbkjTV8I';
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Maximum HTML characters to send to Gemini (keeps within context limits)
const MAX_HTML_LENGTH = 60000;

/**
 * Fetch a page's HTML content.
 * @param {string} url - The URL to fetch
 * @returns {Promise<string>} The HTML content
 */
export async function fetchPageHtml(url) {
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  
  const response = await fetch(fullUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000), // 15s timeout
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Send HTML to Gemini for marketplace signal extraction.
 * @param {string} html - The raw HTML of the listing page
 * @param {string} url - The URL for context
 * @param {string} platform - The marketplace platform (ebay, amazon, etc.)
 * @returns {Promise<{title: string, signals: Array}>}
 */
export async function analyzeWithGemini(html, url, platform) {
  const truncatedHtml = html.substring(0, MAX_HTML_LENGTH);

  const prompt = `You are an expert marketplace analyst AI. Analyze this ${platform} listing page and extract all notable marketplace signals.

URL: ${url}

Return ONLY valid JSON with this exact structure:
{
  "title": "The listing/product title found on the page",
  "signals": [
    {
      "type": "Category of signal",
      "description": "Brief, human-readable description of what was found",
      "severity": "info or warning or alert"
    }
  ]
}

Signal types to look for (use these exact type names):
- "Price Info" — current price, sale price, price drops, price history
- "Stock Status" — availability, quantity remaining, sold out, limited stock
- "Seller Info" — seller rating, seller feedback, seller status
- "Bid Activity" — current bids, bid count, bid history (for auction sites)
- "Offer Status" — offers made/received, best offer info
- "Shipping Info" — shipping cost, delivery estimate, free shipping
- "Condition" — item condition details, refurbished, used, new
- "Listing Status" — active, ended, relisted, expired, flagged
- "Buyer Interest" — watchers, views, favorites, saves count
- "Review" — ratings, review count, review highlights
- "Warning" — any issues, policy violations, suspicious indicators
- "Message" — buyer questions, seller responses, communication

Rules:
- Extract REAL data visible in the HTML — do not fabricate signals
- Include the actual values (prices, counts, ratings) in descriptions
- If a signal type isn't present on the page, do NOT include it
- If the page doesn't appear to be a marketplace listing, return {"title": "Not a listing page", "signals": []}
- Keep descriptions concise (under 80 characters)
- Use "alert" severity for urgent items (sold out, ended, warnings)
- Use "warning" for noteworthy items (low stock, price change)
- Use "info" for standard information (price, condition, shipping)

Page HTML:
${truncatedHtml}`;

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    }),
    signal: AbortSignal.timeout(30000), // 30s timeout for Gemini
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Gemini returned no content (reason: ${reason})`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse Gemini response as JSON: ${text.substring(0, 200)}`);
  }
}
