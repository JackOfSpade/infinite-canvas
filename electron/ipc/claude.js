import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const IMAGE_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heic',
};

function getAnthropicClient(apiKey) {
  if (!apiKey) throw new Error("Anthropic API key is missing. Please add it in settings.");
  return new Anthropic({ apiKey });
}

export async function callClaudeText(prompt, model, apiKey, signal) {
  const anthropic = getAnthropicClient(apiKey);
  
  const response = await anthropic.messages.create({
    model: model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  }, { signal });

  return response.content[0].text;
}

export async function callClaudeVision(imagePaths, prompt, model, apiKey, signal) {
  const anthropic = getAnthropicClient(apiKey);
  const tempFiles = [];

  const contentParts = await Promise.all(imagePaths.map(async (imgPath) => {
    let finalPath = imgPath;
    const extRaw = path.extname(imgPath).toLowerCase();
    
    if (extRaw === '.heic' || extRaw === '.heif') {
      const { convertHeicIfNecessary } = await import('./heicUtils.js');
      finalPath = await convertHeicIfNecessary(imgPath);
      tempFiles.push(finalPath);
    }

    const buffer = await fs.promises.readFile(finalPath);
    const ext = path.extname(finalPath).toLowerCase();
    const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';
    
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: buffer.toString('base64')
      }
    };
  }));

  contentParts.push({ type: 'text', text: prompt });

  try {
    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: contentParts }]
    }, { signal });

    return response.content[0].text;
  } finally {
    if (tempFiles.length > 0) {
      const { cleanupTempFile } = await import('./heicUtils.js');
      await Promise.all(tempFiles.map(f => cleanupTempFile(f)));
    }
  }
}

export async function callClaudeDocument(filePath, prompt, model, apiKey, signal) {
  const ext = path.extname(filePath).toLowerCase();
  
  if (IMAGE_MIME_MAP[ext]) {
    return callClaudeVision([filePath], prompt, model, apiKey, signal);
  }
  
  if (ext === '.doc') {
    throw new Error('Legacy .doc files are not supported. Save as PDF or DOCX and try again.');
  }

  // Claude API requires standard pdf extraction. For text formats, we read as utf8.
  if (ext === '.pdf') {
    const buffer = await fs.promises.readFile(filePath);
    const anthropic = getAnthropicClient(apiKey);
    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 8192,
      messages: [{ 
        role: 'user', 
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: buffer.toString('base64')
            }
          },
          { type: 'text', text: prompt }
        ]
      }]
    }, { signal });
    return response.content[0].text;
  }

  const textContent = await fs.promises.readFile(filePath, 'utf8');
  return callClaudeText(`${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n${textContent}`, model, apiKey, signal);
}
