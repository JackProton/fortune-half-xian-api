const INSIGHT_SYSTEM_PROMPT = [
  "你是六爻读盘助手。",
  "你不重新算卦，只根据提供的原始盘面事实提炼这次独特判断点。",
  "不要给完整签批，不要写安慰话，不要模板套话。",
  "只从原始卦象、世应、动爻、卦辞爻辞里抓最独特的 3 到 5 个判断点。",
  "如果用户问的是具体对象，比如排骨、岗位、相亲对象，就直接写对象本身。",
  "输出必须是 JSON。",
].join(" ");

const FINAL_SYSTEM_PROMPT = [
  "你是半仙断语。",
  "你不重新算卦，只根据提供的盘面事实、古文线索、独特判断点来写一段签批。",
  "签批要像真的看盘之后说的话，不要像总结报告。",
  "如果用户问的是具体对象，比如排骨、岗位、某个人，就直接叫这个对象。",
  "必须明显使用独特判断点，不能回到空泛的统一结论。",
  "总长度控制在 160 到 280 中文字符。",
  "不要分点，不要标题，不要模板套话。",
  "避免这些表达：顺势而为、静观其变、先稳住自己、不要操之过急、关键在于节奏、不会一次定下来、边走边看、等时机、慢慢来。",
].join(" ");

export default async function handler(req, res) {
  writeCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({ ok: true, status: "alive" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed." });
    return;
  }

  const body = req.body;

  if (!isHalfXianRequest(body)) {
    res.status(400).json({ ok: false, error: "Invalid 半仙解卦 request payload." });
    return;
  }

  const relayUrl = process.env.HALF_XIAN_RELAY_URL;
  const relayKey = process.env.HALF_XIAN_RELAY_KEY;
  const relayModel = process.env.HALF_XIAN_RELAY_MODEL;

  if (!relayUrl || !relayKey || !relayModel) {
    res.status(500).json({ ok: false, error: "Missing relay environment variables." });
    return;
  }

  try {
    const digest = buildHalfXianEvidenceDigest(body);
    const insightJson = await callRelay({
      relayUrl,
      relayKey,
      relayModel,
      systemPrompt: INSIGHT_SYSTEM_PROMPT,
      userPrompt: buildInsightPrompt(body, digest),
      maxTokens: 260,
      temperature: 0.8,
    });
    const insight = parseInsightPayload(insightJson);

    const finalText = await callRelay({
      relayUrl,
      relayKey,
      relayModel,
      systemPrompt: FINAL_SYSTEM_PROMPT,
      userPrompt: buildFinalPrompt(body, digest, insight),
      maxTokens: 320,
      temperature: 1.0,
    });

    res.status(200).json({
      ok: true,
      result: {
        mode: "relay",
        text: finalText.trim(),
        styleKey: body.meta?.styleKey,
        styleLabel: body.meta?.styleLabel,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
}

function writeCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function callRelay(input) {
  const response = await fetch(input.relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.relayKey}`,
    },
    body: JSON.stringify({
      model: input.relayModel,
      temperature: input.temperature,
      top_p: 0.92,
      frequency_penalty: 0.45,
      presence_penalty: 0.8,
      max_tokens: input.maxTokens,
      stream: false,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Relay HTTP ${response.status}`);
  }

  const payload = await response.json();
  const text = extractRelayText(payload);

  if (!text) {
    throw new Error("Empty relay response.");
  }

  return text;
}

function extractRelayText(payload) {
  const firstChoice = payload?.choices?.[0];
  const content = firstChoice?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item) {
          return String(item.text);
        }

        return "";
      })
      .join("");
  }

  return "";
}

function buildHalfXianEvidenceDigest(request) {
  return {
    questionType: request.domain,
    questionIntent: request.questionIntent,
    topicText: request.topicText,
    rawFacts: [
      `本卦 ${request.hexagram.originalName}，变卦 ${request.hexagram.changedName}`,
      request.hexagram.movingLines.length > 0 ? `动爻在 ${request.hexagram.movingLines.join("、")} 爻` : "本次无动爻",
      `世在 ${request.hexagram.shiLine} 爻，应在 ${request.hexagram.yingLine} 爻`,
      `月建 ${request.calendar.monthGanZhi}，日辰 ${request.calendar.dayGanZhi}`,
      `旬空 ${request.calendar.voidBranches.join("、")}`,
    ],
    canonHints: [
      `本卦卦辞：${request.canon.originalJudgment}`,
      `变卦卦辞：${request.canon.changedJudgment}`,
      ...request.canon.movingLineTexts.slice(0, 3),
    ],
    lineFacts: request.lines.map((line) =>
      [
        `第 ${line.position} 爻`,
        `${line.sixRelative}`,
        `${line.branch}`,
        line.isShi ? "世" : "",
        line.isYing ? "应" : "",
        line.isMoving ? `发动，化${line.changedSixRelative}${line.changedBranch}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  };
}

function buildInsightPrompt(request, digest) {
  return [
    "请先不要写完整签批，只做第一步：提炼这次读盘最独特的判断点。",
    "",
    `用户问题：${request.question}`,
    `提问意图：${digest.questionIntent}`,
    `用户对象：${digest.topicText}`,
    "原始盘面事实：",
    ...digest.rawFacts.map((item) => `- ${item}`),
    "古文线索：",
    ...digest.canonHints.map((item) => `- ${item}`),
    "每爻事实：",
    ...digest.lineFacts.map((item) => `- ${item}`),
    "",
    "请输出 JSON，格式如下：",
    '{"focusObject":"", "distinctPoints":["", "", ""], "coreTension":"", "bestEntry":"", "tone":""}',
    "",
    "要求：",
    "- distinctPoints 里放 3 到 5 条真正有辨识度的判断点",
    "- 不要写空泛大词",
    "- 不要模板化",
    "- 如果对象很具体，比如排骨、岗位、相亲对象，就直接写对象本身",
  ].join("\n");
}

function buildFinalPrompt(request, digest, insight) {
  return [
    "现在做第二步：把这些独特判断点串成一段半仙口吻的签批。",
    "",
    `用户问题：${request.question}`,
    `对象：${insight.focusObject || digest.topicText}`,
    `风格要求：${request.meta?.stylePrompt || "像街口摊主开口，但不要油滑。"}`,
    "原始盘面事实：",
    ...digest.rawFacts.map((item) => `- ${item}`),
    "古文线索：",
    ...digest.canonHints.map((item) => `- ${item}`),
    "独特判断点：",
    ...insight.distinctPoints.map((item) => `- ${item}`),
    `核心矛盾：${insight.coreTension}`,
    `落笔入口：${insight.bestEntry}`,
    `整体气口：${insight.tone}`,
    "",
    request.meta?.previousText
      ? `上一次签批（本次避免句型相似）：${request.meta.previousText}`
      : "这是第一次签批，不要写成常见模板腔。",
    "",
    "要求：",
    "- 写成一整段签批",
    "- 必须围着这些独特判断点来写，不要回到统一结论",
    "- 必须直接叫用户问的对象，不要退回“这件事”",
    "- 可以带一点六爻味道，但人要能读懂",
    "- 不要分点，不要标题，不要模板套话",
  ].join("\n");
}

function parseInsightPayload(text) {
  const normalized = text.trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON payload.");
  }

  const parsed = JSON.parse(normalized.slice(start, end + 1));

  return {
    focusObject: typeof parsed.focusObject === "string" ? parsed.focusObject : "",
    distinctPoints: Array.isArray(parsed.distinctPoints) ? parsed.distinctPoints.map(String).filter(Boolean).slice(0, 5) : [],
    coreTension: typeof parsed.coreTension === "string" ? parsed.coreTension : "",
    bestEntry: typeof parsed.bestEntry === "string" ? parsed.bestEntry : "",
    tone: typeof parsed.tone === "string" ? parsed.tone : "",
  };
}

function isHalfXianRequest(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return typeof value.question === "string" && typeof value.topicText === "string" && Array.isArray(value.lines);
}
