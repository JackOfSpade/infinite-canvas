import fs from 'fs';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';

/**
 * Gemini AI service — uses Service Account Bearer tokens against the
 * Generative Language API (generativelanguage.googleapis.com).
 * This bills through GCP project credits, not AI Studio prepay.
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';

// Path to the local service account json (git-ignored)
const KEY_FILE = path.join(process.cwd(), 'service-account.json');

// Auth cache
let authClient = null;
let projectId = null;

/**
 * Initialize GoogleAuth from service-account.json
 */
async function getAuthClient() {
  if (authClient) return { auth: authClient, projectId };

  if (!fs.existsSync(KEY_FILE)) {
    throw new Error('service-account.json not found. Place it in the project root.');
  }

  const sa = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  projectId = sa.project_id;

  authClient = new GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  return { auth: authClient, projectId };
}

/**
 * Fetches the raw HTML of a page.
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
      throw new Error('Failed to connect to URL: Network error or CORS blocked.');
    }
    throw new Error(`Failed to fetch page: ${err.message}`);
  }
}

/**
 * Sends HTML to Gemini via Vertex AI (regional endpoint) and extracts signals.
 */
export async function analyzeWithGemini(html, url, platform) {
  const { auth, projectId } = await getAuthClient();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  if (!token) throw new Error('Failed to generate OAuth token from service account.');

  // Use the regional Vertex AI endpoint for Gemini
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  // Truncate HTML to 100k chars for fast parsing
  const MAX_CHARS = 100000;
  const trimmedHtml = html.length > MAX_CHARS ? html.substring(0, MAX_CHARS) + '...' : html;

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
      "description": "A very concise 1-sentence description of the dynamic signal",
      "severity": "info | warning | alert"
    }
  ]
}

HTML Content:
${trimmedHtml}
`;

  const payload = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg;
    try {
      errMsg = JSON.parse(errText)?.error?.message || errText;
    } catch {
      errMsg = errText;
    }
    throw new Error(`Vertex AI error ${response.status}: ${errMsg}`);
  }

  const data = await response.json();
  const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!contentText) throw new Error('No content returned from Vertex AI.');

  // Clean and parse JSON
  let cleaned = contentText.trim();
  if (cleaned.startsWith('\`\`\`json')) cleaned = cleaned.replace('\`\`\`json', '');
  if (cleaned.startsWith('\`\`\`')) cleaned = cleaned.replace('\`\`\`', '');
  if (cleaned.endsWith('\`\`\`')) cleaned = cleaned.slice(0, -3);

  let result;
  try {
    result = JSON.parse(cleaned.trim());
  } catch {
    console.error('[Gemini] Raw response:', contentText);
    throw new Error('Vertex AI returned malformed JSON');
  }

  return result;
}
