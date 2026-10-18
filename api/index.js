// Включаем моментальный запуск Vercel Edge Runtime (старт за 0 мс)
export const config = {
  runtime: 'edge',
};

// ЖЁСТКИЕ НАСТРОЙКИ (с увеличенным временем для поиска)
const MODEL_NAME = "gemini-3.5-flash-lite"; 
const TOTAL_RESPONSE_BUDGET_MS = 2850; 
const SERPER_TIMEOUT_MS = 1400; // Комфортное время для поиска
const GEMINI_TIMEOUT_MS = 1400; // Комфортное время для нейросети
const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1000;
const MAX_ALICE_TEXT = 1024;

// ОБНОВЛЕННЫЙ СИСТЕМНЫЙ ПРОМПТ (Запрещаем задавать уточняющие вопросы по новостям)
const SYSTEM_PROMPT = "Ты — голосовой помощник в навыке Яндекс Алисы. Отвечай по-русски, естественно и кратко (1-3 предложения). Твой ответ будут слушать ушами, поэтому не используй Markdown, спецсимволы и списки. Если пользователь просит новости/погоду и тебе переданы результаты поиска, СРАЗУ сделай выжимку из них и расскажи главные события. КАТЕГОРИЧЕСКИ ЗАПРЕЩАЕТСЯ просить пользователя уточнить тему, сферу или регион новостей — просто перескажи то, что нашлось в поиске. Если результатов нет, честно скажи об этом. Не выдумывай факты.";

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
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";
  return text.slice(0, 1000) + "…";
}

function isSearchIntent(text) {
  // Убраны \b, чтобы русские слова находились идеально
  return /сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит/i.test(text);
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
  if (!key || timeoutMs < 200) return "";

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

    if (!response.ok) {
      console.warn("Serper HTTP status:", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : []).slice(0, 3).map((item, i) => 
      `${i + 1}. ${String(item.title || "").slice(0, 150)}: ${String(item.snippet || "").slice(0, 250)}`
    );
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper aborted or failed:", error.message);
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска:\n${searchContext}\nИспользуй их для ответа.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${key}`;
  console.log(`[DEBUG] Запрос к Gemini URL: ${url}`);

  const { response, data } = await fetchJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 120 }
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error(`[DEBUG] Ошибка Google API: Статус ${status}`, JSON.stringify(data));
    if (status === 400) throw new Error("GEMINI_BAD_REQUEST");
    if (status === 404) throw new Error("GEMINI_NOT_FOUND");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || []).map(p => p.text || "").join("").trim();
  if (!answer) throw new Error("GEMINI_EMPTY_RESPONSE");
  return answer;
}

export default async function handler(req) {
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, message: "Webhook is Edge-ready." }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const startedAt = Date.now();
  const remainingMs = () => Math.max(0, TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt));
  
  let body = {};
  try { body = await req.json(); } catch (e) { /* ignore */ }

  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return new Response(JSON.stringify(aliceResponse("Привет! Я готова отвечать на вопросы и искать новости. Что вас интересует?", false, oldHistory)), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      console.log("[DEBUG] Начинаем поиск Serper...");
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, remainingMs() - 1000));
    }

    console.log(`[DEBUG] Идем в Gemini. Осталось времени: ${remainingMs()}ms`);
    const answer = await askGemini(text, oldHistory, searchContext, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 200));

    const history = [...oldHistory, { role: "user", text }, { role: "model", text: answer }].slice(-MAX_HISTORY_MESSAGES);
    
    return new Response(JSON.stringify(aliceResponse(answer, false, history)), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("🚨 Итоговая ошибка:", error.message);
    
    let errMsg = "Извините, произошла ошибка на сервере.";
    if (error.message.includes("EXHAUSTED") || error.message.includes("AbortError")) errMsg = "Извините, не успела найти информацию.";
    if (error.message === "GEMINI_NOT_FOUND") errMsg = "Не найдена модель нейросети.";
    if (error.message === "GEMINI_BAD_REQUEST") errMsg = "Неверный формат запроса к нейросети.";

    return new Response(JSON.stringify(aliceResponse(errMsg, false, oldHistory)), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
}