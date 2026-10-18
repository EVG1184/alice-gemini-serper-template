const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 800;
const MAX_ALICE_TEXT = 1000;

// Строгие лимиты Яндекса (отключение происходит на 3000 мс)
const TOTAL_RESPONSE_BUDGET_MS = 2800; 
const SERPER_TIMEOUT_MS = 1100;
const GEMINI_TIMEOUT_MS = 1500;

const SYSTEM_PROMPT = [
  "Ты — умный голосовой помощник Алиса.",
  "Отвечай по-русски, естественно, красиво и содержательно. Твой текст зачитывает робот, поэтому пиши только обычные слова и знаки препинания (без Markdown, звездочек и эмодзи).",
  "Числа и аббревиатуры старайся писать словами для правильного произношения."
].join(" ");

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

  if (text.length <= MAX_ALICE_TEXT) return text || "Я ничего не придумала.";
  return text.slice(0, MAX_ALICE_TEXT - 3).trim() + "...";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|recent|search)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи/i.test(text);
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
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 200) return "NO_KEY";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      timeoutMs
    );

    if (!response.ok) return "ERROR";

    const items = [];
    if (Array.isArray(data.news)) {
      for (const item of data.news.slice(0, 3)) {
        items.push(`Новость: ${item.title || ""}. ${item.snippet || ""}`.trim());
      }
    }
    if (!items.length && Array.isArray(data.organic)) {
      for (const item of data.organic.slice(0, 3)) {
        items.push(`${item.title || ""}: ${item.snippet || ""}`.trim());
      }
    }

    return items.length ? items.join("\n") : "EMPTY";
  } catch (error) {
    return "TIMEOUT";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  let prompt = text;
  if (searchContext === "TIMEOUT" || searchContext === "EMPTY" || searchContext === "ERROR") {
    prompt = `${text}\n\n[ВНИМАНИЕ: Поиск в интернете не удался. Прямо скажи пользователю, что не смогла загрузить свежую информацию, и ответь только на основе своих базовых знаний, не придумывая новости.]`;
  } else if (searchContext && searchContext !== "NO_KEY") {
    prompt = `${text}\n\n[РЕЗУЛЬТАТЫ ПОИСКА В ИНТЕРНЕТЕ]:\n${searchContext}\n\n[ИНСТРУКЦИЯ]: Выбери 1-2 самые главные новости из текста выше и расскажи их связным текстом (2-4 предложения). Не обрывай фразу!`;
  }
  
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.6, maxOutputTokens: 200 }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) throw new Error("GEMINI_REQUEST_FAILED");

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || []).map(p => p.text || "").join("").trim();
  
  if (!answer) throw new Error("GEMINI_EMPTY_RESPONSE");
  return answer;
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true });

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body || {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse("Привет! Я на связи. Что хочешь узнать или найти?", false, oldHistory));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text)) {
      searchContext = await searchWeb(text, SERPER_TIMEOUT_MS);
    }

    const answer = await askGemini(text, oldHistory, searchContext, Math.max(500, remainingMs()));
    
    const history = [...oldHistory, { role: "user", text }, { role: "model", text: answer }].slice(-MAX_HISTORY_MESSAGES);
    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const errText = error?.message === "AbortError" 
      ? "Я немного задумалась и не успела подготовить ответ." 
      : "Произошла ошибка при связи с нейросетью.";
    return res.status(200).json(aliceResponse(errText, false, oldHistory));
  }
}