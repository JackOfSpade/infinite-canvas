import { logger } from '../logger.js';
/**
 * Gemini AI service — text + vision support via Vertex AI.
 * Uses Service Account for authentication against regional endpoints.
 */
import fs from 'fs';
import path from 'path';


import { GoogleAuth } from 'google-auth-library';
import { handleSafe } from './ipcUtils.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const KEY_FILE = path.join(process.cwd(), 'service-account.json');

let authClient = null;
let projectId = null;

async function getAuthClient() {
  if (authClient) return { auth: authClient, projectId };
  let saRaw;
  try {
    saRaw = await fs.promises.readFile(KEY_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('service-account.json not found. Place it in the project root.');
    }
    throw err;
  }
  const sa = JSON.parse(saRaw);
  projectId = sa.project_id;
  authClient = new GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  return { auth: authClient, projectId };
}

async function getToken() {
  try {
    const { auth } = await getAuthClient();
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to generate OAuth token from service account.');
    return token;
  } catch (err) {
    // Clear the cached client so the next call retries from scratch.
    // Without this, a broken credential (e.g., rotated service account) is
    // cached permanently for the process lifetime, silently failing every call.
    authClient = null;
    projectId = null;
    throw err;
  }
}

/**
 * Core Gemini call — sends parts (text + optional images) to Vertex AI.
 * @param {Array} parts — Array of { text } or { inlineData: { mimeType, data } } objects
 * @param {object} [genConfig] — generationConfig overrides
 * @returns {Promise<string>} — Raw text response from Gemini
 */
async function callGemini(parts, genConfig = {}) {
  // Hardening: Prevent "Payload Too Large" errors by capping total prompt text.
  // Vertex AI has token limits, but 100k chars is a safe "fail-fast" boundary for
  // strings to prevent massive JSON stringification from crashing the process.
  let totalTextLen = 0;
  for (const part of parts) {
    if (part.text) totalTextLen += part.text.length;
  }
  if (totalTextLen > 100000) {
    throw new Error(`AI prompt too large (${totalTextLen} chars). Please select fewer nodes or a smaller group.`);
  }

  const token = await getToken();
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  const { signal, ...restGenConfig } = genConfig;

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      ...restGenConfig,
    },
  };

  const timeoutSignal = AbortSignal.timeout(60000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(endpoint, {
    method: 'POST',
    signal: combinedSignal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg;
    try { errMsg = JSON.parse(errText)?.error?.message || errText; }
    catch { errMsg = errText; }
    throw new Error(`Vertex AI error ${response.status}: ${errMsg}`);
  }

  const data = await response.json();
  const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!contentText) throw new Error('No content returned from Vertex AI.');

  return contentText;
}

/**
 * Parse raw Gemini response text into JSON, stripping markdown fences if present.
 * Handles both ```json and bare ``` wrappers.
 */
function parseGeminiJSON(raw) {
  if (!raw) return null;
  
  // Resilient JSON extraction: Find the first code block or the outer-most { } pair.
  // This handles instances where Gemini adds markdown fences OR conversational text.
  let jsonStr = raw;
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    jsonStr = match[1];
  } else {
    // If no markdown block, try to find the first { or [ and the last } or ]
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const lastBrace = raw.lastIndexOf('}');
    const lastBracket = raw.lastIndexOf(']');
    
    let start = -1;
    let end = -1;
    
    if (firstBrace !== -1 && firstBracket !== -1) {
      start = Math.min(firstBrace, firstBracket);
    } else if (firstBrace !== -1) {
      start = firstBrace;
    } else if (firstBracket !== -1) {
      start = firstBracket;
    }
    
    if (lastBrace !== -1 && lastBracket !== -1) {
      end = Math.max(lastBrace, lastBracket);
    } else if (lastBrace !== -1) {
      end = lastBrace;
    } else if (lastBracket !== -1) {
      end = lastBracket;
    }

    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = raw.substring(start, end + 1);
    }
  }

  try {
    return JSON.parse(jsonStr.trim());
  } catch (error) {
    logger.error('[Gemini] Failed to parse JSON response:', error.message, '\nRaw Segment:', jsonStr.substring(0, 100));
    throw new Error(`AI returned invalid JSON: ${error.message}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

// MIME type tables — module-level so they're not re-allocated per call.
const IMAGE_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};
const DOCUMENT_MIME_MAP = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt':  'text/plain',
  '.md':   'text/plain',
  '.json': 'text/plain',
  '.js':   'text/plain',
  '.py':   'text/plain',
};

/**
 * Send a text-only prompt to Gemini.
 * @param {string} prompt
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiText(prompt, signal = null) {
  const raw = await callGemini([{ text: prompt }], { signal });
  return parseGeminiJSON(raw);
}

/**
 * Send images + text prompt to Gemini Vision.
 * @param {string[]} imagePaths — Absolute paths to image files
 * @param {string} prompt — Text prompt
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiVision(imagePaths, prompt, signal = null) {
  const imageParts = await Promise.all(imagePaths.map(async (imgPath) => {
    const stats = await fs.promises.stat(imgPath);
    // Vertex AI inlineData limit is 20MB. Base64 encoding adds ~33% overhead,
    // so we cap the raw file size at 15MB to be safe and provide a clear error.
    if (stats.size > 15 * 1024 * 1024) {
      throw new Error(`Image file too large: ${path.basename(imgPath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for AI analysis.`);
    }

    const buffer = await fs.promises.readFile(imgPath);
    const ext = path.extname(imgPath).toLowerCase();
    const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';
    return { inlineData: { mimeType, data: buffer.toString('base64') } };
  }));

  const parts = [...imageParts, { text: prompt }];
  const raw = await callGemini(parts, { signal });
  return parseGeminiJSON(raw);
}

/**
 * Send a PDF or document file to Gemini for analysis.
 * @param {string} filePath — Path to PDF/DOCX file
 * @param {string} prompt — Analysis prompt
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiDocument(filePath, prompt, signal = null) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = DOCUMENT_MIME_MAP[ext];

  if (!mimeType) {
    // Fall back to treating as an image (e.g. screenshot of a resume).
    // callGeminiVision will handle its own file reading.
    return callGeminiVision([filePath], prompt, signal);
  }

  const stats = await fs.promises.stat(filePath);
  // Vertex AI inlineData limit is 20MB. Base64 encoding adds ~33% overhead,
  // so we cap the raw file size at 15MB to be safe and prevent OOM crashes.
  if (stats.size > 15 * 1024 * 1024) {
    throw new Error(`Document file too large: ${path.basename(filePath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for AI analysis.`);
  }

  const buffer = await fs.promises.readFile(filePath);
  const parts = [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: prompt },
  ];

  const raw = await callGemini(parts, { signal });
  return parseGeminiJSON(raw);
}

export function registerGeminiHandlers() {
  handleSafe('ai-polish-text', async (event, text, signal) => {
    const prompt = `You are an AI assistant in a visual workspace app. Polish the following text. Make it clear, concise, and professional. Output ONLY the improved text, without quotes or conversational filler. Keep original markdown formatting if any. The text is:\n\n${text}`;
    const config = { responseMimeType: 'text/plain', signal };
    const raw = await callGemini([{ text: prompt }], config);
    return { text: raw.trim() };
  });
}
