import { getAISettings } from './settings.js';
import { callGeminiText, callGeminiVision, callGeminiDocument, parseGeminiJSON } from './gemini.js';
import { callClaudeText, callClaudeVision, callClaudeDocument } from './claude.js';

// The Gemini wrappers already return parsed JSON; the Claude wrappers return
// the raw response text, so only the Claude path needs parseGeminiJSON.

export async function callLLMText(prompt, signal) {
  const settings = getAISettings();
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeText(prompt, settings.claudeModel, settings.anthropicApiKey, signal);
      return parseGeminiJSON(raw);
    }
    return await callGeminiText(prompt, settings.geminiApiKey, settings.geminiModel, signal);
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

export async function callLLMVision(imagePaths, prompt, signal) {
  const settings = getAISettings();
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeVision(imagePaths, prompt, settings.claudeModel, settings.anthropicApiKey, signal);
      return parseGeminiJSON(raw);
    }
    return await callGeminiVision(imagePaths, prompt, settings.geminiApiKey, settings.geminiModel, signal);
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

export async function callLLMDocument(filePath, prompt, signal) {
  const settings = getAISettings();
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeDocument(filePath, prompt, settings.claudeModel, settings.anthropicApiKey, signal);
      return parseGeminiJSON(raw);
    }
    return await callGeminiDocument(filePath, prompt, settings.geminiApiKey, settings.geminiModel, signal);
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

function enhanceLLMError(error, provider) {
  // If the error message indicates a rate limit or exhaustion, mark it as RATE_LIMIT
  // so the frontend can catch it and display the model selector.
  const msg = error.message?.toLowerCase() || '';
  if (
    msg.includes('rate limit') || 
    msg.includes('429') || 
    msg.includes('insufficient funds') || 
    msg.includes('quota')
  ) {
    error.isRateLimit = true;
    error.provider = provider;
  }
  return error;
}
