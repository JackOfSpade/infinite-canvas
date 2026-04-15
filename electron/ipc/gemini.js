/**
 * Gemini AI service — text + vision support via Vertex AI.
 * Uses Service Account for authentication against regional endpoints.
 */
import fs from 'fs';
import path from 'path';

import { ipcMain } from 'electron';
import { GoogleAuth } from 'google-auth-library';

const GEMINI_MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const KEY_FILE = path.join(process.cwd(), 'service-account.json');

let authClient = null;
let projectId = null;

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

async function getToken() {
  const { auth } = await getAuthClient();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to generate OAuth token from service account.');
  return token;
}

function getEndpoint() {
  return `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
}

/**
 * Core Gemini call — sends parts (text + optional images) to Vertex AI.
 * @param {Array} parts — Array of { text } or { inlineData: { mimeType, data } } objects
 * @param {object} [genConfig] — generationConfig overrides
 * @returns {Promise<string>} — Raw text response from Gemini
 */
async function callGemini(parts, genConfig = {}) {
  const token = await getToken();
  const endpoint = getEndpoint();

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      ...genConfig,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
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
 */
function parseGeminiJSON(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return JSON.parse(cleaned.trim());
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a text-only prompt to Gemini.
 * @param {string} prompt
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiText(prompt) {
  const raw = await callGemini([{ text: prompt }]);
  return parseGeminiJSON(raw);
}

/**
 * Send images + text prompt to Gemini Vision.
 * @param {string[]} imagePaths — Absolute paths to image files
 * @param {string} prompt — Text prompt
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiVision(imagePaths, prompt) {
  const parts = [];

  for (const imgPath of imagePaths) {
    const buffer = fs.readFileSync(imgPath);
    const ext = path.extname(imgPath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    const mimeType = mimeMap[ext] || 'image/jpeg';
    parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
  }

  parts.push({ text: prompt });
  const raw = await callGemini(parts);
  return parseGeminiJSON(raw);
}

/**
 * Send a PDF or document file to Gemini for analysis.
 * @param {string} filePath — Path to PDF/DOCX file
 * @param {string} prompt — Analysis prompt
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiDocument(filePath, prompt) {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  const mimeMap = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.txt': 'text/plain',
  };
  const mimeType = mimeMap[ext];

  if (!mimeType) {
    // Fall back to treating as an image (screenshot of a resume)
    return callGeminiVision([filePath], prompt);
  }

  const parts = [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: prompt },
  ];

  const raw = await callGemini(parts);
  return parseGeminiJSON(raw);
}

export function registerGeminiHandlers() {
  ipcMain.handle('ai-polish-text', async (_event, text) => {
    try {
      const prompt = `You are an AI assistant in a visual workspace app. Polish the following text. Make it clear, concise, and professional. Output ONLY the improved text, without quotes or conversational filler. Keep original markdown formatting if any. The text is:\n\n${text}`;
      const config = { responseMimeType: 'text/plain' }; // or text/plain
      const raw = await callGemini([{ text: prompt }], config);
      return { success: true, text: raw.trim() };
    } catch (e) {
      console.error('[Gemini] Polish failed:', e);
      return { success: false, error: e.message };
    }
  });
}

