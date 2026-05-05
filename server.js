import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(".")); // Serve static files (html, css, js)

// ==================== CONFIGURATION ====================
const PORT = Number(process.env.PORT || 3000);

// LLM Configuration (Ollama, OpenAI-compatible, or Mistral AI)
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "ollama").toLowerCase(); // "ollama", "openai", or "mistral"
const LLM_API_URL = process.env.LLM_API_URL || process.env.OLLAMA_API_URL || process.env.OPENAI_API_BASE || "http://127.0.0.1:11434/api/chat";
const MODEL = process.env.LLM_MODEL || process.env.OPENAI_MODEL || process.env.MISTRAL_MODEL || "llama3";
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.MISTRAL_API_KEY || "";

// Apify Sherlock Configuration
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "";
const APIFY_SHERLOCK_ACTOR = process.env.APIFY_SHERLOCK_ACTOR || "apify/sherlock";

const REQUEST_TIMEOUT_MS = 30000;

const SYSTEM_PROMPT = `ROLE:
You are a trauma-informed AI support tool. You are not a therapist, partner, or authority.

CORE PRINCIPLES:
- Center dignity, autonomy, and human rights
- Do not generalize individual experiences to entire groups
- Avoid stigma, moral panic, or pathologizing identities or professions
- Be transparent about uncertainty and limits

HUMAN NLP CHECK (Apply BEFORE every response):
1. ANCHOR
2. MIRROR
3. REFRAME
4. RAPPORT

OUTPUT STYLE:
ANCHOR:\n...\n\nMIRROR:\n...\n\nREFRAME:\n...\n\nRAPPORT:\n...`;

function buildMessages(userMessage) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];
}

function normalizeResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return "I’m sorry—no response content was returned by the model.";
  }

  if (typeof payload.response === "string" && payload.response.trim()) {
    return payload.response.trim();
  }

  if (payload.message && typeof payload.message.content === "string" && payload.message.content.trim()) {
    return payload.message.content.trim();
  }

  const firstChoice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (firstChoice?.message?.content && typeof firstChoice.message.content === "string") {
    const content = firstChoice.message.content.trim();
    if (content) return content;
  }

  if (typeof firstChoice?.text === "string" && firstChoice.text.trim()) {
    return firstChoice.text.trim();
  }

  return "I’m sorry—I could not parse a complete response from the model.";
}

function isOpenAIStyleUrl(url) {
  return /\/v1\/(chat\/completions|responses)/i.test(url);
}

function createRequestBody(userMessage) {
  const messages = buildMessages(userMessage);

  // Mistral AI uses OpenAI-compatible API
  if (LLM_PROVIDER === "mistral") {
    return {
      model: MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 2000,
    };
  }

  // OpenAI-compatible (including OpenAI itself)
  if (LLM_PROVIDER === "openai" || isOpenAIStyleUrl(LLM_API_URL)) {
    if (/\/v1\/responses/i.test(LLM_API_URL)) {
      return {
        model: MODEL,
        input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
      };
    }

    return {
      model: MODEL,
      messages,
      temperature: 0.6,
      stream: false,
    };
  }

  // Ollama (default)
  return {
    model: MODEL,
    messages,
    stream: false,
  };
}

app.post("/chat", async (req, res) => {
  const userMessage = req.body?.message;

  if (typeof userMessage !== "string" || !userMessage.trim()) {
    return res.status(400).json({ response: "Please send a non-empty string in `message`." });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const requestBody = createRequestBody(userMessage.trim());
    const headers = { "Content-Type": "application/json" };

    if (API_KEY) {
      headers.Authorization = `Bearer ${API_KEY}`;
    }

    console.log("[chat] sending request", {
      url: LLM_API_URL,
      model: MODEL,
      hasApiKey: Boolean(API_KEY),
    });

    const upstream = await fetch(LLM_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const rawText = await upstream.text();
    let json;

    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("[chat] parse error", parseError);
      return res.status(502).json({ response: "The model returned an unreadable response." });
    }

    if (!upstream.ok) {
      const detail = typeof json?.error === "string" ? json.error : JSON.stringify(json);
      console.error("[chat] upstream error", upstream.status, detail);
      return res.status(502).json({ response: `Model request failed (${upstream.status}).` });
    }

    const response = normalizeResponse(json);
    console.log("[chat] success", { length: response.length });
    return res.json({ response });
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error("[chat] timeout after 30s");
      return res.status(504).json({ response: "The model took too long to respond. Please try again." });
    }

    console.error("[chat] internal error", error);
    return res.status(500).json({ response: "Something went wrong while processing your request." });
  } finally {
    clearTimeout(timeoutId);
  }
});

app.get("/health", (_req, res) => {
  res.json({ response: "ok" });
});

// ==================== SHERLOCK ENDPOINT (Apify) ====================
app.post("/sherlock", async (req, res) => {
  if (!APIFY_API_TOKEN) {
    return res.status(400).json({ 
      error: "Apify API token not configured. Set APIFY_API_TOKEN environment variable." 
    });
  }

  const { usernames } = req.body;
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ 
      error: "Provide an array of usernames to check: { \"usernames\": [\"username1\", \"username2\"] }" 
    });
  }

  try {
    console.log("[sherlock] Running Sherlock for usernames:", usernames);

    const runResponse = await fetch("https://api.apify.com/v2/acts/apify~sherlock/runs", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${APIFY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        usernames: usernames,
        maxConcurrency: 5,
      }),
    });

    if (!runResponse.ok) {
      const error = await runResponse.text();
      console.error("[sherlock] Apify error:", runResponse.status, error);
      return res.status(502).json({ 
        error: "Apify API request failed. Check your APIFY_API_TOKEN.",
        details: error,
      });
    }

    const runData = await runResponse.json();
    const runId = runData.data.id;
    console.log("[sherlock] Started run:", runId);

    // Poll for results (up to 30 seconds)
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds
    const maxWait = 30000; // 30 seconds

    while (Date.now() - startTime < maxWait) {
      const statusResponse = await fetch(`https://api.apify.com/v2/acts/apify~sherlock/runs/${runId}`, {
        headers: { "Authorization": `Bearer ${APIFY_API_TOKEN}` },
      });

      const statusData = await statusResponse.json();
      const status = statusData.data.status;

      if (status === "SUCCEEDED") {
        // Now fetch the results
        const resultResponse = await fetch(
          `https://api.apify.com/v2/acts/apify~sherlock/runs/${runId}/dataset/items`,
          {
            headers: { "Authorization": `Bearer ${APIFY_API_TOKEN}` },
          }
        );

        const results = await resultResponse.json();
        console.log("[sherlock] Results retrieved");
        return res.json({ 
          results: results,
          message: "Sherlock search completed. Results show usernames found on public platforms.",
        });
      } else if (status === "FAILED" || status === "ABORTED") {
        return res.status(502).json({ 
          error: `Sherlock run ${status}. Try again or check Apify logs.` 
        });
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return res.status(504).json({ 
      error: "Sherlock took too long to complete. Try again or check Apify logs." 
    });
  } catch (error) {
    console.error("[sherlock] error:", error);
    return res.status(500).json({ 
      error: "Internal server error while running Sherlock.",
      details: error.message,
    });
  }
});

// Serve ui.html as the default page at root
app.get("/", (_req, res) => {
  res.sendFile("ui.html", { root: process.cwd() });
});

app.listen(PORT, () => {
  console.log(`\n🚀 PI_AI Local Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📍 Server running at http://localhost:${PORT}`);
  console.log(`\n🤖 LLM Configuration:`);
  console.log(`   Provider: ${LLM_PROVIDER.toUpperCase()}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   URL: ${LLM_API_URL}`);
  console.log(`   API Key: ${API_KEY ? "✅ Configured" : "❌ Not configured"}`);
  console.log(`\n🔍 Sherlock (Apify) Configuration:`);
  console.log(`   API Token: ${APIFY_API_TOKEN ? "✅ Configured" : "❌ Not configured"}`);
  console.log(`   Endpoint: POST /sherlock`);
  console.log(`\n📚 Available Endpoints:`);
  console.log(`   POST /chat - Send a message`);
  console.log(`   POST /sherlock - Run Sherlock username search`);
  console.log(`   GET /health - Health check`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
