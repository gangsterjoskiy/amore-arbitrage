const MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_TIMEOUT_MS = 1700;

function extractText(result) {
  if (typeof result === "string") return result;
  return result?.response ?? result?.output_text ?? result?.result?.response ?? result?.choices?.[0]?.message?.content ?? "";
}
function parseObject(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("ИИ вернул ответ не в JSON");
  return JSON.parse(text.slice(start, end + 1));
}
function validDirection(value) {
  return ["UP", "DOWN", "NO_TRADE"].includes(value) ? value : null;
}
function cleanAnalyst(value, name) {
  const direction = validDirection(value?.direction);
  const confidence = Number(value?.confidence);
  if (!direction || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("ИИ вернул некорректный вывод аналитика: " + name);
  }
  return {
    direction,
    confidence: Number(confidence.toFixed(2)),
    argument: String(value.argument || "").slice(0, 420),
    counterargument: String(value.counterargument || "").slice(0, 300)
  };
}
export async function runAICommittee(env, market, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("AI binding не подключён. Нужен Workers AI binding с именем AI.");
  }
  const prompt = [
    "Ты — комитет краткосрочного технического анализа. Анализируй только переданные рыночные данные. Не выдумывай котировки, индикаторы, новости или источники.",
    "Сначала независимо сформируй четыре позиции: trend (тренд и импульс), candles (свечи и форма последних баров), price_action (структура, уровни и пробой/отбой), critic (обязательно ищи сильнейшие аргументы ПРОТИВ наиболее вероятного направления; не соглашайся автоматически с большинством).",
    "Затем chief — главный арбитр — должен сопоставить все четыре позиции, разрешить противоречия и вынести UP, DOWN или NO_TRADE. Не считай confidence вероятностью выигрыша. Если контекст слабый, противоречивый или свечи устарели — NO_TRADE.",
    "Ответь только JSON без Markdown по схеме:",
    '{"analysts":{"trend":{"direction":"UP|DOWN|NO_TRADE","confidence":0.0,"argument":"...","counterargument":"..."},"candles":{"direction":"UP|DOWN|NO_TRADE","confidence":0.0,"argument":"...","counterargument":"..."},"price_action":{"direction":"UP|DOWN|NO_TRADE","confidence":0.0,"argument":"...","counterargument":"..."},"critic":{"direction":"UP|DOWN|NO_TRADE","confidence":0.0,"argument":"...","counterargument":"..."}},"verdict":{"direction":"UP|DOWN|NO_TRADE","confidence":0.0,"reason":"...","invalidation":"..."}}',
    "Рынок: " + JSON.stringify(market)
  ].join("\n");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("AI Committee превысил лимит ожидания " + timeoutMs + " мс")), timeoutMs);
  });
  const startedAt = Date.now();
  try {
    const inference = env.AI.run(MODEL, {
      messages: [
        { role: "system", content: "Ты строгий финансовый аналитик. Не обещай точность. Не используй данные вне входного контекста. Верни только валидный JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 700
    });
    const result = await Promise.race([inference, timeout]);
    const parsed = parseObject(extractText(result));
    const analysts = parsed?.analysts || {};
    const normalized = {
      trend: cleanAnalyst(analysts.trend, "trend"),
      candles: cleanAnalyst(analysts.candles, "candles"),
      price_action: cleanAnalyst(analysts.price_action, "price_action"),
      critic: cleanAnalyst(analysts.critic, "critic")
    };
    const verdictDirection = validDirection(parsed?.verdict?.direction);
    const confidence = Number(parsed?.verdict?.confidence);
    if (!verdictDirection || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("Главный арбитр вернул некорректный вердикт");
    }
    return {
      model: MODEL,
      latencyMs: Date.now() - startedAt,
      analysts: normalized,
      verdict: {
        direction: verdictDirection,
        confidence: Number(confidence.toFixed(2)),
        reason: String(parsed.verdict.reason || "").slice(0, 700),
        invalidation: String(parsed.verdict.invalidation || "").slice(0, 300)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}
