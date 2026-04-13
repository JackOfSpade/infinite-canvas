import 'dotenv/config';

const GEMINI_API_KEY = process.env.VITE_GEMINI_API_KEY;

async function run() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GEMINI_API_KEY}`
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }]
      })
    });
    
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`HTTP ${response.status}: ${err}`);
    }
    const data = await response.json();
    console.log("Success!", JSON.stringify(data.candidates[0].content));
  } catch (err) {
    console.error("Test failed:", err);
  }
}

run();
