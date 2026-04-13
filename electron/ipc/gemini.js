import fs from 'fs';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';

/**
 * Monitoring IPC handlers — powered by Gemini AI via Vertex AI.
 * Uses Service Account dynamically to consume Vertex credits.
 */

// We will use gemini-1.5-flash-002 as the default fast analysis model on Vertex
const GEMINI_MODEL = 'gemini-1.5-flash-002';
const LOCATION = 'us-central1';

// Hardcoded path to the local service account json (git-ignored)
const KEY_FILE = path.join(process.cwd(), 'service-account.json');

// Memory cache for our auth client
let authClient = null;
let projectId = null;

/**
 * Initializes the GoogleAuth library using the service-account.json
 * Extracts projectId and configures OAuth 2.0 scopes.
 */
async function getAuthClient() {
  if (authClient) return authClient;

  if (!fs.existsSync(KEY_FILE)) {
    throw new Error('service-account.json not found in the root directory. Missing authentication.');
  }

  const sa = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  projectId = sa.project_id;

  authClient = new GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  return authClient;
}

/**
 * Fetches the raw HTML of a page via a standard fetch (impersonating a generic browser).
 */
export async function fetchPageHtml(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    if (err.message.includes('fetch failed')) {
      throw new Error(`Failed to connect to URL: Network error or CORS blocked.`);
    }
    throw new Error(`Failed to fetch page: ${err.message}`);
  }
}

/**
 * Sends HTML to Gemini via Vertex AI and asks for structured signals.
 */
export async function analyzeWithGemini(html, url, platform) {
  // 1. Get bearer token dynamically
  const auth = await getAuthClient();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  if (!token) throw new Error("Failed to generate Vertex AI OAuth token.");

  // 2. Format Vertex AI API endpoint
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  // 3. Truncate HTML to stay within 1M context safely and fast parsing
  const MAX_CHARS = 100000; 
  const trimmedHtml = html.length > MAX_CHARS ? html.substring(0, MAX_CHARS) + "..." : html;

  // 4. Construct prompt schema
  const promptText = `
You are a live marketplace monitoring assistant. 
Extract real-time status signals from the provided listing HTML.

Marketplace: ${platform}
URL: ${url}

Return ONLY a valid JSON object matching this schema exactly. Do NOT wrap it in \`\`\`json or any markdown formatting.

{
  "title": "Clean, human-readable item title (or null if not found)",
  "signals": [
    {
      "type": "Price Info | Stock Status | Bid Activity | Seller Info | Buyer Interest | Shipping Info | Listing Status | Warning | Review | Message",
      "description": "A very concise 1-sentence description of the dynamic signal (e.g. 'Price dropped to $40', 'Only 2 items left in stock', 'Listing has 14 bids')",
      "severity": "info" | "warning" | "alert"
    }
  ]
}

HTML Content:
${trimmedHtml}
`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    let parsedErr;
    try {
      parsedErr = JSON.parse(errText);
    } catch {
      //
    }
    const errMsg = parsedErr?.error?.message || errText;
    throw new Error(`Vertex AI error ${response.status}: ${errMsg}`);
  }

  const data = await response.json();
  const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!contentText) {
    throw new Error("No textual content returned from Vertex AI.");
  }

  // Safely parse JSON
  let cleaned = contentText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace('```json', '');
  if (cleaned.startsWith('```')) cleaned = cleaned.replace('```', '');
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

  let result;
  try {
    result = JSON.parse(cleaned.trim());
  } catch (parseErr) {
    console.error('[Gemini] RAW response was:', contentText);
    throw new Error("Vertex AI returned malformed JSON");
  }

  return result;
}
