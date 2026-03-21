const FACT_CHECK_SYSTEM_PROMPT = `You are an expert fact-checker. Analyze the provided content and:
1. Identify all specific factual claims
2. Assess each claim's accuracy
3. Provide an overall verdict

Respond ONLY with valid JSON in this exact structure (no markdown, no code fences, nothing outside the JSON):
{
  "overall_verdict": "true" | "false" | "misleading" | "unverifiable",
  "summary": "One sentence overall summary",
  "claims": [
    {
      "claim": "The specific claim extracted from the content",
      "verdict": "true" | "false" | "misleading" | "unverifiable",
      "explanation": "2-3 sentences explaining your assessment"
    }
  ]
}

Verdict rules:
- "true" = accurate and well-supported
- "false" = demonstrably incorrect  
- "misleading" = has factual elements but framed deceptively or missing key context
- "unverifiable" = cannot be determined
- If there are no factual claims, use overall_verdict "unverifiable" and summary "No specific factual claims detected."`;

// Vision models to try in order (HuggingFace Inference Providers)
const HF_VISION_MODELS = [
  "meta-llama/Llama-3.2-11B-Vision-Instruct",
  "Qwen/Qwen2.5-VL-7B-Instruct",
  "meta-llama/Llama-3.2-11B-Vision-Instruct:cerebras",
  "meta-llama/Llama-3.2-11B-Vision-Instruct:fireworks-ai",
  "Qwen/Qwen2.5-VL-7B-Instruct:fireworks-ai",
];

// Text-only models for fact-checking after OCR
const HF_TEXT_MODELS = [
  "meta-llama/Llama-3.1-8B-Instruct:cerebras",
  "Qwen/Qwen2.5-72B-Instruct",
  "meta-llama/Meta-Llama-3.1-8B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
];

const HF_ROUTER_URL = "https://router.huggingface.co/v1/chat/completions";

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "factcheck:capture") {
    handleCapture(msg.rect, sender.tab);
    sendResponse({ ok: true });
  }
  if (msg.type === "factcheck:manualtext") {
    handleManualText(msg.text, sender.tab);
    sendResponse({ ok: true });
  }
  return true;
});

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function handleCapture(rect, tab) {
  try {
    await notify(tab.id, "Capturing screenshot...");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    await notify(tab.id, "Cropping selection...");
    const croppedDataUrl = await cropImage(dataUrl, rect);

    const config = await chrome.storage.local.get(null);
    const provider = config.activeProvider;
    if (!provider)
      throw new Error(
        "No AI provider configured. Open the extension and set a provider.",
      );

    const apiKey = config[`${provider}_key`];
    if (!apiKey)
      throw new Error(
        `No API key for ${provider}. Open the extension settings.`,
      );

    const model = config[`${provider}_model`] || defaultModel(provider);

    let result;

    if (provider === "claude") {
      await notify(tab.id, "Analyzing with Claude...");
      result = await callClaudeCombined(croppedDataUrl, apiKey, model);
    } else if (provider === "openai") {
      await notify(tab.id, "Analyzing with OpenAI...");
      result = await callOpenAICombined(croppedDataUrl, apiKey, model);
    } else if (provider === "huggingface") {
      result = await handleHuggingFace(croppedDataUrl, apiKey, model, tab.id);
      if (!result) return; // needtext flow triggered
    } else if (provider === "deepseek") {
      await notify(tab.id, "Extracting text...");
      const text = await extractTextBestEffort(croppedDataUrl, config, tab.id);
      if (!text) {
        await requestManualText(tab.id, croppedDataUrl);
        return;
      }
      await notify(tab.id, "Fact-checking with DeepSeek...");
      result = await callDeepSeek(text, apiKey, model);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "factcheck:result",
      data: result,
    });
  } catch (err) {
    console.error("[FactCheck]", err);
    await sendToTab(tab.id, {
      type: "factcheck:error",
      error: err.message || "Something went wrong.",
    });
  }
}

async function handleManualText(text, tab) {
  try {
    const config = await chrome.storage.local.get(null);
    const provider = config.activeProvider;
    if (!provider) throw new Error("No AI provider configured.");
    const apiKey = config[`${provider}_key`];
    if (!apiKey) throw new Error(`No API key for ${provider}.`);
    const model = config[`${provider}_model`] || defaultModel(provider);

    await notify(tab.id, `Fact-checking with ${providerLabel(provider)}...`);

    let result;
    if (provider === "claude")
      result = await callClaudeText(text, apiKey, model);
    else if (provider === "openai")
      result = await callOpenAIText(text, apiKey, model);
    else if (provider === "huggingface")
      result = await callHuggingFaceText(text, apiKey, model);
    else if (provider === "deepseek")
      result = await callDeepSeek(text, apiKey, model);
    else throw new Error(`Unknown provider: ${provider}`);

    await chrome.tabs.sendMessage(tab.id, {
      type: "factcheck:result",
      data: result,
    });
  } catch (err) {
    console.error("[FactCheck] manual text error:", err);
    await sendToTab(tab.id, {
      type: "factcheck:error",
      error: err.message || "Something went wrong.",
    });
  }
}

// ── HuggingFace handler ───────────────────────────────────────────────────────

async function handleHuggingFace(imageDataUrl, apiKey, configModel, tabId) {
  const base64 = stripBase64Prefix(imageDataUrl);

  const visionModels =
    configModel && isVisionModel(configModel)
      ? [configModel, ...HF_VISION_MODELS.filter((m) => m !== configModel)]
      : HF_VISION_MODELS;

  await notify(tabId, "Analyzing image with HuggingFace vision...");

  for (const model of visionModels) {
    await notify(tabId, `Trying ${shortModelName(model)}...`);
    try {
      const result = await callHuggingFaceVisionCombined(base64, apiKey, model);
      if (result) {
        console.log("[FactCheck] HF vision success with model:", model);
        return result;
      }
    } catch (e) {
      // Auth/rate limit errors should bubble up immediately
      if (e.message.includes("API key") || e.message.includes("rate limit"))
        throw e;
      console.warn(
        "[FactCheck] HF vision failed with model:",
        model,
        e.message,
      );
    }
  }

  // Fallback: OCR first, then text fact-check
  await notify(tabId, "Trying OCR + text approach...");
  const extractedText = await extractTextViaHuggingFace(base64, apiKey);

  if (extractedText) {
    await notify(tabId, "Fact-checking extracted text...");
    const textModel =
      configModel && !isVisionModel(configModel)
        ? configModel
        : HF_TEXT_MODELS[0];
    return await callHuggingFaceText(extractedText, apiKey, textModel);
  }

  // Last resort: ask user
  await requestManualText(tabId, `data:image/png;base64,${base64}`);
  return null;
}

async function callHuggingFaceVisionCombined(base64, apiKey, model) {
  const prompt = `You are an expert fact-checker. Look at this screenshot carefully.

Read all the text visible in the image, then fact-check any factual claims you find.

Respond ONLY with a valid JSON object in exactly this format (no markdown fences, no extra text):
{"overall_verdict":"true or false or misleading or unverifiable","summary":"One sentence summary","claims":[{"claim":"specific claim","verdict":"true or false or misleading or unverifiable","explanation":"2-3 sentence explanation"}]}

If there is no text or no factual claims, return:
{"overall_verdict":"unverifiable","summary":"No specific factual claims detected.","claims":[]}`;

  const res = await fetch(HF_ROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401)
      throw new Error("Invalid HuggingFace API key. Check your settings.");
    if (res.status === 429)
      throw new Error("HuggingFace rate limit hit. Please wait and try again.");
    console.warn(`[FactCheck] HF vision model ${model} failed: ${msg}`);
    return null;
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  if (!raw.trim()) return null;

  try {
    return parseJson(raw, "HuggingFace");
  } catch (e) {
    console.warn(
      "[FactCheck] HF vision parse failed for model:",
      model,
      "- raw:",
      raw.substring(0, 300),
    );
    return null;
  }
}

async function extractTextViaHuggingFace(base64, apiKey) {
  for (const model of HF_VISION_MODELS) {
    try {
      const res = await fetch(HF_ROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${base64}` },
                },
                {
                  type: "text",
                  text: "Extract ALL text visible in this image exactly as it appears. Output ONLY the raw text, nothing else - no commentary, no explanation.",
                },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn(
          "[FactCheck] HF OCR model",
          model,
          "failed:",
          res.status,
          err?.error?.message,
        );
        if (res.status === 401) throw new Error("Invalid HuggingFace API key.");
        continue;
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 10) {
        console.log(
          "[FactCheck] HF OCR success with model:",
          model,
          "- chars:",
          text.length,
        );
        return text;
      }
    } catch (e) {
      if (e.message.includes("API key")) throw e;
      console.warn("[FactCheck] HF OCR model", model, "error:", e.message);
    }
  }
  return null;
}

async function callHuggingFaceText(text, apiKey, preferredModel) {
  const models = preferredModel
    ? [preferredModel, ...HF_TEXT_MODELS.filter((m) => m !== preferredModel)]
    : HF_TEXT_MODELS;

  for (const model of models) {
    try {
      const res = await fetch(HF_ROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          messages: [
            { role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Fact-check the following text extracted from a screenshot:\n\n${text}\n\nReturn ONLY the JSON object, no other text, no markdown fences.`,
            },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn(
          "[FactCheck] HF text model",
          model,
          "failed:",
          res.status,
          err?.error?.message,
        );
        if (res.status === 401) throw new Error("Invalid HuggingFace API key.");
        if (res.status === 429)
          throw new Error(
            "HuggingFace rate limit hit. Please wait and try again.",
          );
        continue;
      }

      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || "";
      if (!raw.trim()) continue;

      try {
        return parseJson(raw, "HuggingFace");
      } catch {
        console.warn("[FactCheck] HF text model parse failed for:", model);
        continue;
      }
    } catch (e) {
      if (e.message.includes("API key") || e.message.includes("rate limit"))
        throw e;
      console.warn("[FactCheck] HF text model", model, "error:", e.message);
    }
  }

  throw new Error(
    "All HuggingFace models failed. Check your API key or try again later.",
  );
}

// ── Claude API calls ──────────────────────────────────────────────────────────

async function callClaudeCombined(imageDataUrl, apiKey, model) {
  const base64 = stripBase64Prefix(imageDataUrl);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: FACT_CHECK_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: base64 },
            },
            {
              type: "text",
              text: "Fact-check the content in this screenshot. Return only the JSON.",
            },
          ],
        },
      ],
    }),
  });
  await assertOk(res, "Claude");
  const data = await res.json();
  return parseJson(data.content?.[0]?.text || "", "Claude");
}

async function callClaudeText(text, apiKey, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: FACT_CHECK_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Fact-check the following text:\n\n${text}\n\nReturn only the JSON.`,
        },
      ],
    }),
  });
  await assertOk(res, "Claude");
  const data = await res.json();
  return parseJson(data.content?.[0]?.text || "", "Claude");
}

// ── OpenAI API calls ──────────────────────────────────────────────────────────

async function callOpenAICombined(imageDataUrl, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            {
              type: "text",
              text: `${FACT_CHECK_SYSTEM_PROMPT}\n\nFact-check this screenshot. Return only the JSON.`,
            },
          ],
        },
      ],
    }),
  });
  await assertOk(res, "OpenAI");
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "", "OpenAI");
}

async function callOpenAIText(text, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        { role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Fact-check:\n\n${text}\n\nReturn only the JSON.`,
        },
      ],
    }),
  });
  await assertOk(res, "OpenAI");
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "", "OpenAI");
}

// ── DeepSeek API call ─────────────────────────────────────────────────────────

async function callDeepSeek(text, apiKey, model) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        { role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Fact-check the following text:\n\n${text}\n\nReturn only the JSON.`,
        },
      ],
    }),
  });
  await assertOk(res, "DeepSeek");
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "", "DeepSeek");
}

// ── OCR best-effort (for non-vision providers) ────────────────────────────────

async function extractTextBestEffort(imageDataUrl, config, tabId) {
  const base64 = stripBase64Prefix(imageDataUrl);

  const claudeKey = config.claude_key;
  if (claudeKey) {
    await notify(tabId, "Extracting text via Claude OCR...");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: base64,
                  },
                },
                {
                  type: "text",
                  text: "Extract all text from this image verbatim. Return only the raw text.",
                },
              ],
            },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text?.trim();
        if (text && text.length > 5) return text;
      }
    } catch (e) {
      console.warn("[FactCheck] Claude OCR failed:", e.message);
    }
  }

  const hfKey = config.huggingface_key;
  if (hfKey) {
    await notify(tabId, "Extracting text via HuggingFace vision...");
    const text = await extractTextViaHuggingFace(base64, hfKey);
    if (text) return text;
  }

  return null;
}

async function requestManualText(tabId, imageDataUrl) {
  await sendToTab(tabId, {
    type: "factcheck:needtext",
    imageDataUrl,
    message:
      "Could not extract text automatically. Please paste the text you want to fact-check.",
  });
}

// ── Image crop ────────────────────────────────────────────────────────────────

async function cropImage(dataUrl, rect) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const img = await createImageBitmap(blob);

  const dpr = rect.devicePixelRatio || 1;
  const sx = Math.max(0, Math.round(rect.viewX * dpr));
  const sy = Math.max(0, Math.round(rect.viewY * dpr));
  const sw = Math.min(Math.round(rect.width * dpr), img.width - sx);
  const sh = Math.min(Math.round(rect.height * dpr), img.height - sy);

  if (sw <= 0 || sh <= 0)
    throw new Error("Selection is outside the visible screen area.");

  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(outBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripBase64Prefix(dataUrl) {
  return dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
}

function isVisionModel(model) {
  const lower = model.toLowerCase();
  return (
    lower.includes("vision") || lower.includes("vl-") || lower.includes("-vl")
  );
}

function shortModelName(model) {
  return model
    .split("/")
    .pop()
    .split(":")[0]
    .replace(/-Instruct|-Vision/gi, "")
    .trim();
}

async function assertOk(res, providerName) {
  if (res.ok) return;
  const err = await res.json().catch(() => ({}));
  const msg = err?.error?.message || err?.message || `HTTP ${res.status}`;
  if (res.status === 401)
    throw new Error(`Invalid API key for ${providerName}. Check settings.`);
  if (res.status === 429)
    throw new Error(
      `${providerName} rate limit reached. Please wait and try again.`,
    );
  throw new Error(`${providerName} error: ${msg}`);
}

function parseJson(raw, providerName) {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {}
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  throw new Error(`Could not parse ${providerName} response. Try again.`);
}

function defaultModel(provider) {
  return (
    {
      claude: "claude-sonnet-4-6",
      openai: "gpt-4o",
      deepseek: "deepseek-chat",
      huggingface: "meta-llama/Llama-3.2-11B-Vision-Instruct",
    }[provider] || ""
  );
}

function providerLabel(provider) {
  return (
    {
      claude: "Claude",
      openai: "ChatGPT",
      deepseek: "DeepSeek",
      huggingface: "HuggingFace",
    }[provider] || provider
  );
}

async function notify(tabId, text) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "factcheck:loading", text });
  } catch {}
}

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {}
}
