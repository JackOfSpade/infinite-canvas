import fs from 'fs';
import { GoogleAuth } from 'google-auth-library';

async function run() {
  try {
    const keyFile = './service-account.json';
    if (!fs.existsSync(keyFile)) {
      throw new Error(`File not found: ${keyFile}`);
    }

    const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const projectId = sa.project_id;
    console.log(`Authenticating for project: ${projectId}`);

    const auth = new GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;
    
    // We'll use us-central1 as the default Vertex AI region
    const location = 'us-central1';
    const model = 'gemini-1.5-flash-002';
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

    console.log("Fetching test payload via Vertex AI...");
    const reqBody = {
      contents: [{ role: "user", parts: [{ text: "Respond with exactly the word SUCCESS." }] }]
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(reqBody)
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log("Vertex AI response:", text);

  } catch (err) {
    console.error("Test failed:", err.message || err);
  }
}

run();
