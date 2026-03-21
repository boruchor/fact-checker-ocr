// background.js — FactCheck AI (multi-provider)
// Supports: Claude (Anthropic), ChatGPT (OpenAI), DeepSeek, HuggingFace / Llama

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

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'factcheck:capture') {
    handleCapture(msg.rect, sender.tab);
    sendResponse({ ok: true });
  }
  return true;
});

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function handleCapture(rect, tab) {
  try {
    await notify(tab.id, 'Capturing screenshot…');
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    await notify(tab.id, 'Cropping selection…');
    const croppedDataUrl = await cropImage(dataUrl, rect);

    // Load config
    const config = await chrome.storage.local.get(null);
    const provider = config.activeProvider;
    if (!provider) throw new Error('No AI provider configured. Open the extension and set a provider.');

    const apiKey = config[`${provider}_key`];
    if (!apiKey) throw new Error(`No API key for ${provider}. Open the extension settings.`);

    const model = config[`${provider}_model`] || defaultModel(provider);

    await notify(tab.id, `Sending to ${providerLabel(provider)}…`);

    let result;

    if (provider === 'claude') {
      result = await callClaude(croppedDataUrl, apiKey, model);
    } else if (provider === 'openai') {
      result = await callOpenAI(croppedDataUrl, apiKey, model);
    } else if (provider === 'deepseek') {
      await notify(tab.id, 'Extracting text from screenshot…');
      const text = await extractText(croppedDataUrl, config, null);
      await notify(tab.id, 'Fact-checking with DeepSeek…');
      result = await callDeepSeek(text, apiKey, model);
    } else if (provider === 'huggingface') {
      await notify(tab.id, 'Extracting text from screenshot…');
      const text = await extractText(croppedDataUrl, config, apiKey);
      await notify(tab.id, `Fact-checking with HuggingFace… (${text.length} chars)`);
      console.log('[FactCheck] Text sent to HuggingFace:', text.substring(0, 200));
      result = await callHuggingFace(text, apiKey, model);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    await chrome.tabs.sendMessage(tab.id, { type: 'factcheck:result', data: result });

  } catch (err) {
    console.error('[FactCheck]', err);
    await sendToTab(tab.id, { type: 'factcheck:error', error: err.message || 'Something went wrong.' });
  }
}

// ── Image crop (OffscreenCanvas) ──────────────────────────────────────────────

async function cropImage(dataUrl, rect) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const img = await createImageBitmap(blob);

  const dpr = rect.devicePixelRatio || 1;
  const sx = Math.max(0, Math.round(rect.viewX * dpr));
  const sy = Math.max(0, Math.round(rect.viewY * dpr));
  const sw = Math.min(Math.round(rect.width * dpr), img.width - sx);
  const sh = Math.min(Math.round(rect.height * dpr), img.height - sy);

  if (sw <= 0 || sh <= 0) throw new Error('Selection is outside the visible screen area.');

  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(outBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}

// ── OCR: extract text from image ─────────────────────────────────────────────
// Priority: 1) Claude (best quality)  2) HuggingFace vision  3) Fail with clear error

// async function extractText(imageDataUrl, config, hfApiKey) {
//   // 1. Try Claude if key is available
//   const claudeText = await extractTextViaClaude(imageDataUrl, config);
//   if (claudeText) {
//     console.log('[FactCheck] OCR via Claude, length:', claudeText.length);
//     return claudeText;
//   }

//   // 2. Try HuggingFace vision model (Llama-3.2-11B-Vision is free-tier accessible)
//   if (hfApiKey) {
//     const hfText = await extractTextViaHuggingFace(imageDataUrl, hfApiKey);
//     if (hfText) {
//       console.log('[FactCheck] OCR via HuggingFace vision, length:', hfText.length);
//       return hfText;
//     }
//   }

//   // 3. Nothing worked
//   throw new Error(
//     'Could not extract text from the screenshot. ' +
//     'For best results, add a Claude API key in settings (used only for OCR). ' +
//     'Alternatively, select text-heavy content with clear, readable text.'
//   );
// }

// async function extractTextViaClaude(imageDataUrl, config) {
//   const claudeKey = config.claude_key;
//   if (!claudeKey) return null;

//   const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, '');
//   try {
//     const res = await fetch('https://api.anthropic.com/v1/messages', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'x-api-key': claudeKey,
//         'anthropic-version': '2023-06-01',
//       },
//       body: JSON.stringify({
//         model: 'claude-haiku-4-5-20251001',
//         max_tokens: 1000,
//         messages: [{
//           role: 'user',
//           content: [
//             { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
//             { type: 'text', text: 'Extract all text from this image verbatim. Return only the raw extracted text, nothing else.' }
//           ]
//         }]
//       })
//     });
//     if (!res.ok) return null;
//     const data = await res.json();
//     const text = data.content?.[0]?.text?.trim();
//     return text || null;
//   } catch {
//     return null;
//   }
// }

async function extractTextViaHuggingFace(imageDataUrl, apiKey) {
  // Use a vision-capable model on HuggingFace for OCR
  const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, '');
  const imageUrl = imageDataUrl; // HF vision accepts data URLs directly

  // Try multiple vision models in order of preference
  const visionModels = [
    'meta-llama/Llama-3.2-11B-Vision-Instruct:cerebras',
    'meta-llama/Llama-3.2-11B-Vision-Instruct:fireworks-ai',
    'Qwen/Qwen2.5-VL-7B-Instruct:fireworks-ai',
    'meta-llama/Llama-3.2-11B-Vision-Instruct:together',
  ];

  for (const model of visionModels) {
    try {
      const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${base64}` }
              },
              {
                type: 'text',
                text: 'Extract all text visible in this image verbatim. Return only the raw text content, nothing else. If there is no text, describe what you see briefly.'
              }
            ]
          }]
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[FactCheck] HF vision model', model, 'failed:', err?.error?.message);
        continue; // try next model
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 5) return text;
    } catch (e) {
      console.warn('[FactCheck] HF vision model', model, 'error:', e.message);
    }
  }

  return null;
}

async function callClaude(imageDataUrl, apiKey, model) {
  const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, '');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: FACT_CHECK_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: 'Fact-check the content in this screenshot. Return only the JSON.' }
        ]
      }]
    })
  });

  await assertOk(res, 'Claude');
  const data = await res.json();
  return parseJson(data.content?.[0]?.text || '', 'Claude');
}

async function callOpenAI(imageDataUrl, apiKey, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: FACT_CHECK_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: 'Fact-check the content in this screenshot. Return only the JSON.' }
          ]
        }
      ]
    })
  });

  await assertOk(res, 'OpenAI');
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || '', 'OpenAI');
}

async function callDeepSeek(text, apiKey, model) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: FACT_CHECK_SYSTEM_PROMPT },
        { role: 'user', content: `Fact-check the following text extracted from a screenshot:\n\n${text}\n\nReturn only the JSON.` }
      ]
    })
  });

  await assertOk(res, 'DeepSeek');
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || '', 'DeepSeek');
}

async function callHuggingFace(text, apiKey, model) {
  const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'meta-llama/Llama-3.2-3B-Instruct',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: FACT_CHECK_SYSTEM_PROMPT },
        { role: 'user', content: `Fact-check the following text extracted from a screenshot:\n\n${text}\n\nReturn only the JSON object, no other text.` }
      ]
    })
  });

  await assertOk(res, 'HuggingFace');
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || '', 'HuggingFace');
}

async function assertOk(res, providerName) {
  if (res.ok) return;
  const err = await res.json().catch(() => ({}));
  const msg = err?.error?.message || err?.message || `HTTP ${res.status}`;
  if (res.status === 401) throw new Error(`Invalid API key for ${providerName}. Check settings.`);
  if (res.status === 429) throw new Error(`${providerName} rate limit reached. Please wait and try again.`);
  throw new Error(`${providerName} error: ${msg}`);
}

function parseJson(raw, providerName) {
  const text = raw.trim();
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  throw new Error(`Could not parse ${providerName} response. Try again.`);
}

function defaultModel(provider) {
  return {
    claude: 'claude-opus-4-5',
    openai: 'gpt-4o',
    deepseek: 'deepseek-chat',
    huggingface: 'meta-llama/Llama-3.1-8B-Instruct:cerebras',
  }[provider] || '';
}

function providerLabel(provider) {
  return { claude: 'Claude', openai: 'ChatGPT', deepseek: 'DeepSeek', huggingface: 'HuggingFace' }[provider] || provider;
}

async function notify(tabId, text) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'factcheck:loading', text }); } catch {}
}

async function sendToTab(tabId, msg) {
  try { await chrome.tabs.sendMessage(tabId, msg); } catch {}
}
