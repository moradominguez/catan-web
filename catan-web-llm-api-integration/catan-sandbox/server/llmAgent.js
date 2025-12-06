// server/llmAgent.js
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const ANTHROPIC_VERSION = "2023-06-01";

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "rollDice",
        "moveRobber",
        "buildRoad",
        "buildTown",
        "buildCity",
        "harborTrade",
        "buyDevCard",
        "playKnight",
        "playRoadBuilding",
        "playYearOfPlenty",
        "playMonopoly",
        "endTurn",
      ],
    },
    payload: { type: "object", additionalProperties: true },
    reason: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["action", "payload", "reason"],
};

function buildSystemPrompt() {
  return [
    "You are an expert Settlers of Catan player. Play strictly by rules.",
    "Return ONLY a single JSON object (no markdown) matching the schema.",
    "",
    "CRITICAL TURN ORDER RULES:",
    "1) If current player's hasRolled=false, your ONLY legal action is rollDice (payload must be {}).",
    "2) If current player's hasRolled=true, you MUST NOT choose rollDice again.",
    "3) If you cannot do any legal build/trade/devcard action after rolling, choose endTurn.",
    "",
    "CRITICAL ID RULE:",
    "- tileId/nodeId/edgeId are ARRAY INDICES from the snapshot lists.",
    "- Use ONLY ids that appear in tiles/openNodes/openEdges.",
    "",
    "If a build fails, try a different id from the lists rather than giving up immediately.",
  ].join("\n");
}

function summarizeGame(game) {
  const tiles = (game.board?.tiles || []).map((t, tileId) => ({
    tileId,
    resource: t.resource,
    number: t.number,
    hasRobber: t.hasRobber,
  }));

  const openNodes = (game.board?.nodes || [])
    .map((n, nodeId) => ({ n, nodeId }))
    .filter(({ n }) => !!n && !n.building && n.canBuild)
    .map(({ n, nodeId }) => ({ nodeId, adjHexes: n.adjHexes }));

  const openEdges = (game.board?.edges || [])
    .map((e, edgeId) => ({ e, edgeId }))
    .filter(({ e }) => !!e && e.ownerId == null)
    .map(({ e, edgeId }) => ({ edgeId, n1: e.n1, n2: e.n2 }));

  const players = (game.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    vp: p.vp,
    resources: p.resources,
    hasRolled: p.hasRolled,
    boughtDevCardThisTurn: p.boughtDevCardThisTurn,
    devCards: {
      playable: (p.devCards || []).filter((c) => c.canPlay).map((c) => c.type),
      inHand: (p.devCards || []).map((c) => c.type),
    },
  }));

  const robberHexId = tiles.find((t) => t.hasRobber)?.tileId ?? -1;

  return {
    gameId: game.id,
    currentIndex: game.current,
    currentPlayerName: players?.[game.current]?.name,
    lastRoll: game.lastRoll,
    devCardsRemaining: game.devCardDeck?.length,
    robberHexId,
    tiles,
    openNodes,
    openEdges,
    players,
  };
}

function tryParseJson(text) {
  if (!text) throw new Error("Empty model response");
  let cleaned = String(text).trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```.*?\n/, "").replace(/```$/, "").trim();
  }
  return JSON.parse(cleaned);
}

function parseChatCompletionResponse(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model returned no content");
  return tryParseJson(content);
}

function parseAnthropicResponse(res) {
  const block = res?.content?.find((p) => p?.type === "text");
  if (!block?.text) throw new Error("Anthropic returned empty message");
  return tryParseJson(block.text);
}

function resolveApiKey(config = {}) {
  if (config.apiKey) return config.apiKey;

  if (config.provider === "google" && process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Ollama doesn't need a real key but OpenAI SDK requires a string
  if (config.provider === "ollama") return "ollama-local-key";

  return process.env.OPENAI_API_KEY || "";
}

function resolveBaseURL(config = {}) {
  if (config.provider === "google") return GEMINI_OPENAI_BASE;
  if (config.apiEndpoint) return String(config.apiEndpoint).replace(/\/+$/, "");
  return undefined;
}

function normalizeModelForProvider(provider, model) {
  if (!model) return model;
  if (provider === "ollama") {
    // Your Ollama tag list shows llama3.2:latest, so make the default match.
    return model.includes(":") ? model : `${model}:latest`;
  }
  return model;
}

function getClient(config = {}) {
  const provider = config.provider || "openai";
  const apiKey = resolveApiKey(config);

  if (provider === "anthropic") {
    return {
      client: new Anthropic({
        apiKey,
        anthropicVersion: ANTHROPIC_VERSION,
        baseURL: config.apiEndpoint,
      }),
      kind: "anthropic",
    };
  }

  if (provider === "google") {
    return {
      client: new OpenAI({
        apiKey,
        baseURL: GEMINI_OPENAI_BASE,
        defaultHeaders: { "x-goog-api-key": apiKey },
      }),
      kind: "openai-chat",
    };
  }

  // OpenAI-compatible (OpenAI, Ollama, xAI, etc.)
  return {
    client: new OpenAI({
      apiKey: provider === "ollama" ? "ollama-local-key" : apiKey,
      baseURL: resolveBaseURL(config),
    }),
    kind: "openai-chat",
  };
}

async function getLLMAction(game, { llmConfig = {}, model, notes, apiKey, apiEndpoint } = {}) {
  const merged = {
    ...llmConfig,
    provider: llmConfig.provider || "openai",
    model: model || llmConfig.model || DEFAULT_MODEL,
    apiKey: apiKey || llmConfig.apiKey,
    apiEndpoint: apiEndpoint || llmConfig.apiEndpoint,
  };

  merged.model = normalizeModelForProvider(merged.provider, merged.model);

  const { client: llmClient, kind } = getClient(merged);
  const snapshot = summarizeGame(game);

  const systemMessage = `${buildSystemPrompt()}\n\nJSON schema:\n${JSON.stringify(ACTION_SCHEMA)}`;

  const userMessage = [
    `Decide ONE action for the CURRENT player.`,
    `CURRENT player index=${snapshot.currentIndex}, name=${snapshot.currentPlayerName}.`,
    notes ? `NOTES / RETRY FEEDBACK:\n${notes}` : null,
    `SNAPSHOT:\n${JSON.stringify(snapshot)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let parsed, usage;

  if (kind === "anthropic") {
    const completion = await llmClient.messages.create({
      model: merged.model,
      system: systemMessage,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: 600,
    });
    parsed = parseAnthropicResponse(completion);
    usage = completion.usage;
  } else {
    // Ollama sometimes doesn’t support response_format; keep it prompt-driven and parse.
    const completion = await llmClient.chat.completions.create({
      model: merged.model,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
    });
    parsed = parseChatCompletionResponse(completion);
    usage = completion.usage;
  }

  return { ...parsed, model: merged.model, snapshot, usage };
}

module.exports = {
  ACTION_SCHEMA,
  DEFAULT_MODEL,
  buildSystemPrompt,
  getLLMAction,
  summarizeGame,
  resolveApiKey,
};
