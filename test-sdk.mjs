import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';

async function run() {
  try {
    const keyFile = './service-account.json';
    const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    
    // Explicitly seed the env variable for the GenAI SDK
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;

    // Use explicit GoogleAuth to get the project dynamically so we don't hardcode it if it varies
    const ai = new GoogleGenAI({
      vertexai: {
        project: sa.project_id,
        location: 'us-central1'
      }
    });

    console.log(`Pinging Vertex AI via unified SDK...`);
    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: 'Say the word SUCCESS',
    });

    console.log("Response:", response.text);
  } catch (err) {
    console.error("Test failed:", err?.message || err);
  }
}

run();
