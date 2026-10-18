const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 800;
const MAX_ALICE_TEXT = 1000;

// ЖЕСТКИЕ ЛИМИТЫ (Гарантия ответа Алисы без зависаний)
const YANDEX_MAX_TIME_MS = 2200; // Ровно 2.2 секунды на всё
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 1400;

const SYSTEM_PROMPT = "Ты — Алиса. Отвечай прямо, по фактам. НИКАКИХ извинений, НИКОГДА не говори 'Извините, но я не могу'. Запрещены Markdown, звездочки и эмодзи. Отвечай в 1-2 предложениях.";

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[*#_~`\[\]<>|]/g, "")
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Я не смогла подготовить ответ.";
  return text.slice(0, MAX_ALICE_TEXT - 3).trim() + "...";
}

function isSearchIntent(text) {
  return /\b(новост|сегодня|сейчас|найди|поищи|что нового|расскажи)\b/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return "";

  const { response, data, error } = await fetchJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 2 }) // Берем только 2 ссылки для скорости
    },
    SERPER_TIMEOUT_MS
  );

  if (error || !response?.ok) return "";

  const items = [];
  // Читаем ТОЛЬКО короткие заголовки, чтобы не тратить время нейросети
  if (Array.isArray(data?.news)) {
    for (const item of data.news.slice(0, 2)) items.push(`${item.title || ""}.`);
  } else if (Array.isArray(data?.organic)) {
    for (const item of data.organic.slice(0, 2)) items.push(`${item.title || ""}.`);
  }
  return items.join(" ");
}

async function askGemini(text, history, searchContext) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "Ключ Gemini не найден в настройках Vercel.";
  
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  let prompt = text;
  if (searchContext) {
    prompt = `${text}\n[СВЕЖИЕ ФАКТЫ]: ${searchContext}\n[ПРАВИЛО]: Расскажи об этом ОДНИМ кратким предложением. НИКАКИХ ИЗВИНЕНИЙ.`;
  } else {
    prompt = `${text}\n[ПРАВИЛО]: Отвечай коротко. НИКАКИХ ИЗВИНЕНИЙ.`;
  }
  
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data, error } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 100 }, // Жесткий лимит на длину ответа
        safetySettings: [ // Принудительно отключаем цензуру
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      })
    },
    GEMINI_TIMEOUT_MS
  );

  if (error || !response?.ok) return "Произошла техническая заминка.";

  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return answer || "Я не знаю, что ответить.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  const body = req.body || {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse("Привет! Что поискать?", false, oldHistory));
  }

  // ГАРАНТИЯ ОТВЕТА: Этот таймер сработает ровно через 2.2 секунды, если нейросеть будет "тормозить"
  const timeoutPromise = new Promise(resolve => 
    setTimeout(() => resolve(aliceResponse("Новостей слишком много я не успела их прочитать. Спросите о чем то конкретном.", false, oldHistory)), YANDEX_MAX_TIME_MS)
  );

  const processPromise = (async () => {
    const searchContext = isSearchIntent(text) ? await searchWeb(text) : "";
    const answer = await askGemini(text, oldHistory, searchContext);
    
    const history = [...oldHistory, { role: "user", text }, { role: "model", text: answer }].slice(-MAX_HISTORY_MESSAGES);
    return aliceResponse(answer, false, history);
  })();

  // Запускаем гонку: кто ответит первым (нейросеть или таймер-предохранитель), тот ответ и уйдет в колонку
  const finalResult = await Promise.race([processPromise, timeoutPromise]);
  return res.status(200).json(finalResult);
}