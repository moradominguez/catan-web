// server/server.js (Express API for CatanGame)
const express = require("express");
const cors = require("cors");
const { CatanGame } = require("./CatanGame");
const { getLLMAction, DEFAULT_MODEL, resolveApiKey } = require("./llmAgent");
const { pickAlgorithmAction } = require("./algorithms");

const app = express();
app.use(cors());
app.use(express.json());

const games = new Map(); // gameId -> CatanGame

const VERIFY_TIMEOUT_MS = 6000;
const MAX_LLM_ATTEMPTS = 3;
const MAX_ACTIONS_PER_TURN = 8; // roll + trade/build loops + end
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/** --------------------------
 *  LLM key verification
 *  -------------------------- */
function buildVerificationRequest(provider, apiKey, apiEndpoint) {
  const trimmedEndpoint = (apiEndpoint || "").replace(/\/$/, "");

  switch (provider) {
    case "openai":
      return {
        url: `${trimmedEndpoint || "https://api.openai.com"}/v1/models`,
        options: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      };

    case "anthropic": {
      const base = (trimmedEndpoint || "https://api.anthropic.com").replace(/\/v1$/, "");
      return {
        url: `${base}/v1/models`,
        options: {
          method: "GET",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        },
      };
    }

    case "google": {
      const endpoint = trimmedEndpoint || GEMINI_OPENAI_BASE;
      return {
        url: `${endpoint}/models`,
        options: {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}`, "x-goog-api-key": apiKey },
        },
      };
    }

    case "huggingface":
      return {
        url: `${trimmedEndpoint || "https://api-inference.huggingface.co"}/models`,
        options: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      };

    case "ollama": {
      const base = (trimmedEndpoint || "http://localhost:11434").replace(/\/v1$/, "");
      return { url: `${base}/api/tags`, options: { method: "GET" } };
    }

    case "xai":
    case "deepseek":
    case "meta":
    case "mistral":
    case "openrouter":
    default:
      return {
        url: `${trimmedEndpoint || "https://api.openai.com"}/v1/models`,
        options: { method: "GET", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      };
  }
}

async function verifyApiKey(provider, apiKey, apiEndpoint) {
  const request = buildVerificationRequest(provider, apiKey, apiEndpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(request.url, {
      ...(request.options || {}),
      signal: controller.signal,
    });
    const detail = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, detail: detail?.slice(0, 300) };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEndpoint(provider, apiEndpoint) {
  const raw = (apiEndpoint || "").replace(/\/+$/, "");
  if (!raw) return raw;

  if (provider === "ollama") {
    // OpenAI SDK needs /v1
    return raw.endsWith("/v1") ? raw : `${raw}/v1`;
  }
  return raw;
}

/** --------------------------
 *  Game action executor
 *  -------------------------- */
function getCurrentPlayerId(game) {
  const p = game.players?.[game.current];
  return p?.id ?? game.current;
}

function performAction(game, type, payload = {}) {
  const safePlayerId = payload.playerId ?? getCurrentPlayerId(game);

  switch (type) {
    case "rollDice":
      return game.rollDice();
    case "moveRobber":
      return game.moveRobber(payload.hexId);
    case "buildRoad":
      return game.buildRoad(payload.edgeId, safePlayerId, { free: !!payload.free });
    case "buildTown":
      return game.buildTown(payload.nodeId, safePlayerId);
    case "buildCity":
      return game.buildCity(payload.nodeId, safePlayerId);
    case "harborTrade":
      return game.tradeHarbor(safePlayerId, payload.giveResource, payload.receiveResource);
    case "buyDevCard":
      return game.buyDevCard(safePlayerId);
    case "playKnight":
      return game.playKnight(safePlayerId);
    case "playRoadBuilding":
      return game.playRoadBuilding(safePlayerId);
    case "playYearOfPlenty":
      return game.playYearOfPlenty(safePlayerId, payload.resource1, payload.resource2);
    case "playMonopoly":
      return game.playMonopoly(safePlayerId, payload.resource);
    case "endTurn":
      return game.endTurn();
    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

/** --------------------------
 *  Utilities
 *  -------------------------- */
function uniq(arr) {
  return [...new Set(arr.filter((x) => x !== undefined && x !== null))];
}
function toInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

/** --------------------------
 *  Resource & scoring helpers (STRATEGY)
 *  ✅ Canonical keys: wood, brick, wheat, sheep, ore
 *  -------------------------- */
const RES_ALIASES = {
  // canonical
  wood: "wood",
  brick: "brick",
  wheat: "wheat",
  sheep: "sheep",
  ore: "ore",

  // synonyms -> canonical
  lumber: "wood",
  timber: "wood",

  clay: "brick",

  grain: "wheat",

  wool: "sheep",
};

function normResKey(k) {
  const key = String(k || "").toLowerCase().trim();
  return RES_ALIASES[key] || key;
}

function getRes(player, key) {
  const k = normResKey(key);
  const r = player?.resources || {};
  return Number(r[k] ?? 0);
}

function canAfford(player, cost) {
  return Object.entries(cost).every(([k, v]) => getRes(player, k) >= v);
}

const COSTS = {
  road: { wood: 1, brick: 1 },
  town: { wood: 1, brick: 1, wheat: 1, sheep: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { wheat: 1, sheep: 1, ore: 1 },
};

// 2d6 distribution for numbers on tiles
const DICE_P = {
  2: 1 / 36,
  3: 2 / 36,
  4: 3 / 36,
  5: 4 / 36,
  6: 5 / 36,
  8: 5 / 36,
  9: 4 / 36,
  10: 3 / 36,
  11: 2 / 36,
  12: 1 / 36,
};

// probability weights for 2d6 kept the same
const RES_VALUE_SETTLEMENT = { wood: 1.0, brick: 1.0, sheep: 1.0, wheat: 1.15, ore: 1.1 };
const RES_VALUE_CITY = { wood: 1.0, brick: 0.95, sheep: 0.95, wheat: 1.25, ore: 1.4 };

const RESOURCE_KEYS = ["wood", "brick", "wheat", "sheep", "ore"];

function getTileInfo(game, tileId) {
  const t = game.board?.tiles?.[tileId];
  if (!t) return null;
  const res = normResKey(t.resource);

  return { res, num: t.number, hasRobber: !!t.hasRobber };
}

function nodeProductionScore(game, nodeId, mode = "settlement") {
  const node = game.board?.nodes?.[nodeId];
  if (!node) return -Infinity;

  const weights = mode === "city" ? RES_VALUE_CITY : RES_VALUE_SETTLEMENT;

  let score = 0;
  const seen = new Set();

  const adj = Array.isArray(node.adjHexes) ? node.adjHexes : [];
  for (const hexId of adj) {
    const ti = getTileInfo(game, hexId);
    if (!ti) continue;
    if (!ti.res || ti.res === "desert") continue;

    const p = DICE_P[ti.num] ?? 0;
    const w = weights[ti.res] ?? 1.0;

    score += p * w;

    if (ti.hasRobber) score -= 0.15; // robber penalty
    seen.add(ti.res);
  }

  // small diversity bonus
  score += Math.max(0, seen.size - 1) * 0.05;

  return score;
}

function edgeExpansionScore(game, edgeId) {
  const e = game.board?.edges?.[edgeId];
  if (!e) return -Infinity;

  const n1 = toInt(e.n1);
  const n2 = toInt(e.n2);

  let s = 0;
  if (Number.isFinite(n1)) s = Math.max(s, nodeProductionScore(game, n1, "settlement"));
  if (Number.isFinite(n2)) s = Math.max(s, nodeProductionScore(game, n2, "settlement"));

  const node1 = game.board?.nodes?.[n1];
  const node2 = game.board?.nodes?.[n2];
  if (node1 && !node1.building && node1.canBuild) s += 0.05;
  if (node2 && !node2.building && node2.canBuild) s += 0.05;

  return s;
}

function getBuildingOwnerId(b) {
  if (!b) return null;
  return b.ownerId ?? b.playerId ?? b.owner ?? null;
}
function getBuildingType(b) {
  if (!b) return "";
  const t = (b.type ?? b.kind ?? b.name ?? (typeof b === "string" ? b : ""))
    .toString()
    .toLowerCase();
  return t;
}
function isSettlementBuilding(b) {
  const t = getBuildingType(b);
  return t.includes("town") || t.includes("settlement") || t === "village";
}
function isCityBuilding(b) {
  const t = getBuildingType(b);
  return t.includes("city");
}

function upgradableSettlementNodeIds(game, playerId) {
  const nodes = game.board?.nodes || [];
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n?.building) continue;
    const owner = getBuildingOwnerId(n.building);
    if (owner !== playerId) continue;
    if (isSettlementBuilding(n.building) && !isCityBuilding(n.building)) out.push(i);
  }
  return out;
}

/** --------------------------
 *  Candidate id lists (✅ FIXED: USE INDICES ONLY)
 *  -------------------------- */
function candidateNodeIds(game) {
  const nodes = game.board?.nodes || [];
  const ids = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    // don’t trust canBuild; let the engine decide legality
    if (!n.building) ids.push(i);
  }
  return uniq(ids);
}

function candidateEdgeIds(game) {
  const edges = game.board?.edges || [];
  const ids = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e) continue;
    // ✅ treat null/undefined/-1 as unowned
    if (e.ownerId == null || e.ownerId === -1) ids.push(i);
  }
  return uniq(ids);
}

function candidateHexIds(game) {
  const tiles = game.board?.tiles || [];
  const ids = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t) continue;
    if (!t.hasRobber) ids.push(i);
  }
  return uniq(ids);
}

/** --------------------------
 *  STRATEGIC PICKERS
 *  -------------------------- */
function rankedTownNodeIds(game) {
  const legal =
    typeof game.getLegalActions === "function"
      ? game.getLegalActions(getCurrentPlayerId(game))?.buildTown || []
      : [];

  const nodeIds = legal.length
    ? legal.map((a) => toInt(a.nodeId)).filter((x) => x != null)
    : candidateNodeIds(game);

  return uniq(nodeIds)
    .map((nodeId) => ({ nodeId, score: nodeProductionScore(game, nodeId, "settlement") }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.nodeId);
}

function rankedCityNodeIds(game, playerId) {
  const legal =
    typeof game.getLegalActions === "function"
      ? game.getLegalActions(playerId)?.buildCity || []
      : [];

  const nodeIds = legal.length
    ? legal.map((a) => toInt(a.nodeId)).filter((x) => x != null)
    : upgradableSettlementNodeIds(game, playerId);

  return uniq(nodeIds)
    .map((nodeId) => ({ nodeId, score: nodeProductionScore(game, nodeId, "city") }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.nodeId);
}

function rankedRoadEdgeIds(game) {
  const pid = getCurrentPlayerId(game);
  const legal =
    typeof game.getLegalActions === "function"
      ? game.getLegalActions(pid)?.buildRoad || []
      : [];

  const edgeIds = legal.length
    ? legal.map((a) => toInt(a.edgeId)).filter((x) => x != null)
    : candidateEdgeIds(game);

  return uniq(edgeIds)
    .map((edgeId) => ({ edgeId, score: edgeExpansionScore(game, edgeId) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.edgeId);
}

/** --------------------------
 *  Harbor trade heuristic
 *  -------------------------- */
function pickHarborTradeAction(game) {
  const player = game.players?.[game.current];
  if (!player) return null;

  // Engine requires a roll before trading
  if (!player.hasRolled) return null;

  const priorities = ["city", "town", "road", "dev"];

  for (const type of priorities) {
    const cost = COSTS[type];
    if (!cost) continue;

    // If we can already afford this, no need to trade for it
    if (canAfford(player, cost)) continue;

    // Compute which resources we're missing for this cost
    const missing = {};
    let hasMissing = false;
    for (const [res, needed] of Object.entries(cost)) {
      const have = getRes(player, res);
      if (have < needed) {
        missing[res] = needed - have;
        hasMissing = true;
      }
    }
    if (!hasMissing) continue;

    // Choose which resource we want to receive:
    // pick the one we're most short on
    let receiveResource = null;
    let maxMissing = -1;
    for (const [res, m] of Object.entries(missing)) {
      if (m > maxMissing) {
        maxMissing = m;
        receiveResource = res;
      }
    }

    // Choose which resource to give:
    // any resource (not equal to receive) with at least 4 units (bank 4:1);
    // if player has a better harbor, engine will accept with fewer.
    let giveResource = null;
    for (const res of RESOURCE_KEYS) {
      if (res === receiveResource) continue;
      const have = getRes(player, res);
      if (have >= 4) {
        giveResource = res;
        break;
      }
    }

    if (giveResource && receiveResource) {
      return {
        action: "harborTrade",
        payload: { giveResource, receiveResource },
        reason: `Strategic: trade ${giveResource} for ${receiveResource} toward ${type}.`,
      };
    }
  }

  return null;
}

/** --------------------------
 *  SAFETY + STRATEGY APPLY
 *  -------------------------- */
function applyActionSafely(game, actionObj) {
  const action = actionObj?.action;
  const payload = isObj(actionObj?.payload) ? { ...actionObj.payload } : {};
  payload.playerId = payload.playerId ?? getCurrentPlayerId(game);

  const player = game.players?.[game.current];
  const hasRolled = !!player?.hasRolled;

  // Must roll first
  if (!hasRolled && action !== "rollDice") {
    const event = performAction(game, "rollDice", {});
    return {
      event,
      actionObj: { action: "rollDice", payload: {}, reason: "Must roll before other actions." },
    };
  }

  // Don't roll twice
  if (hasRolled && action === "rollDice") {
    const event = performAction(game, "endTurn", {});
    return {
      event,
      actionObj: { action: "endTurn", payload: {}, reason: "Already rolled; ending turn." },
    };
  }

  // Town: best nodes first (✅ capture last error)
  if (action === "buildTown") {
    const wanted = toInt(payload.nodeId);
    const order = uniq([wanted, ...rankedTownNodeIds(game)]);

    let lastErr = null;

    for (const nodeId of order) {
      if (nodeId == null) continue;
      try {
        const event = performAction(game, action, { ...payload, nodeId });
        return { event, actionObj: { ...actionObj, action, payload: { ...payload, nodeId } } };
      } catch (e) {
        lastErr = e;
      }
    }

    const event = performAction(game, "endTurn", {});
    const msg = lastErr?.message ? ` Last error: ${lastErr.message}` : "";
    return {
      event,
      actionObj: {
        action: "endTurn",
        payload: {},
        reason: `No legal settlement placement.${msg}`,
      },
    };
  }

  // City: best upgrades first (✅ capture last error)
  if (action === "buildCity") {
    const pid = payload.playerId;
    const wanted = toInt(payload.nodeId);
    const order = uniq([wanted, ...rankedCityNodeIds(game, pid)]);

    let lastErr = null;

    for (const nodeId of order) {
      if (nodeId == null) continue;
      try {
        const event = performAction(game, action, { ...payload, nodeId });
        return { event, actionObj: { ...actionObj, action, payload: { ...payload, nodeId } } };
      } catch (e) {
        lastErr = e;
      }
    }

    const event = performAction(game, "endTurn", {});
    const msg = lastErr?.message ? ` Last error: ${lastErr.message}` : "";
    return {
      event,
      actionObj: {
        action: "endTurn",
        payload: {},
        reason: `No legal city upgrade.${msg}`,
      },
    };
  }

  // Road: best expansion edges first (✅ capture last error)
  if (action === "buildRoad") {
    const wanted = toInt(payload.edgeId);
    const order = uniq([wanted, ...rankedRoadEdgeIds(game)]);

    let lastErr = null;

    for (const edgeId of order) {
      if (edgeId == null) continue;
      try {
        const event = performAction(game, action, { ...payload, edgeId });
        return { event, actionObj: { ...actionObj, action, payload: { ...payload, edgeId } } };
      } catch (e) {
        lastErr = e;
      }
    }

    const event = performAction(game, "endTurn", {});
    const msg = lastErr?.message ? ` Last error: ${lastErr.message}` : "";
    return {
      event,
      actionObj: {
        action: "endTurn",
        payload: {},
        reason: `No legal road placement.${msg}`,
      },
    };
  }

  // Robber: a legal hex (also capture last error for consistency)
  if (action === "moveRobber") {
    const wanted = toInt(payload.hexId);
    const order = uniq([wanted, ...candidateHexIds(game)]);

    let lastErr = null;

    for (const hexId of order) {
      if (hexId == null) continue;
      try {
        const event = performAction(game, action, { ...payload, hexId });
        return { event, actionObj: { ...actionObj, action, payload: { ...payload, hexId } } };
      } catch (e) {
        lastErr = e;
      }
    }

    const event = performAction(game, "endTurn", {});
    const msg = lastErr?.message ? ` Last error: ${lastErr.message}` : "";
    return {
      event,
      actionObj: { action: "endTurn", payload: {}, reason: `Could not move robber legally.${msg}` },
    };
  }

  // Default: try once, else endTurn
  try {
    const event = performAction(game, action, payload);
    return { event, actionObj: { ...actionObj, action, payload } };
  } catch (e) {
    const event = performAction(game, "endTurn", {});
    return {
      event,
      actionObj: { action: "endTurn", payload: {}, reason: `Fallback after error: ${e.message}` },
    };
  }
}

/** --------------------------
 *  STRATEGIC OVERRIDE
 *  -------------------------- */
function strategicBestAction(game) {
  const player = game.players?.[game.current];
  if (!player) return { action: "endTurn", payload: {}, reason: "No player state." };
  if (!player.hasRolled) return { action: "rollDice", payload: {}, reason: "Strategic: roll first." };

  const pid = getCurrentPlayerId(game);

  if (canAfford(player, COSTS.city) && rankedCityNodeIds(game, pid).length > 0) {
    return { action: "buildCity", payload: {}, reason: "Strategic: upgrade best settlement to a City." };
  }
  if (canAfford(player, COSTS.town) && rankedTownNodeIds(game).length > 0) {
    return { action: "buildTown", payload: {}, reason: "Strategic: build Settlement at best open node." };
  }
  if (canAfford(player, COSTS.road) && rankedRoadEdgeIds(game).length > 0) {
    return { action: "buildRoad", payload: {}, reason: "Strategic: build Road toward best expansion." };
  }
  if (canAfford(player, COSTS.dev)) {
    return { action: "buyDevCard", payload: {}, reason: "Strategic: buy Dev Card (no better build available)." };
  }

  // 🔁 NEW: before giving up, try a harbor trade to convert surplus into needed resource
  const tradeAction = pickHarborTradeAction(game);
  if (tradeAction) return tradeAction;

  console.log("AFFORD CHECK", {
    pid,
    resources: player.resources,
    canTown: canAfford(player, COSTS.town),
    canRoad: canAfford(player, COSTS.road),
    canCity: canAfford(player, COSTS.city),
    canDev: canAfford(player, COSTS.dev),
  });

  return { action: "endTurn", payload: {}, reason: "Strategic: nothing affordable/valuable; end turn." };
}

function shouldOverrideLLM(game, rawActionObj) {
  const player = game.players?.[game.current];
  if (!player) return true;

  const a = rawActionObj?.action;
  if (!a) return true;

  const wantsPass = a === "endTurn" || (a === "rollDice" && player.hasRolled);
  if (wantsPass) {
    const best = strategicBestAction(game);
    return best.action !== "endTurn";
  }
  return false;
}

function sanitizeActionObj(x) {
  if (!x || typeof x !== "object") return { action: "endTurn", payload: {}, reason: "Invalid LLM output." };
  const action = x.action;
  const payload = isObj(x.payload) ? x.payload : {};
  const reason = typeof x.reason === "string" ? x.reason : "";
  return { action, payload, reason };
}

/** --------------------------
 *  Health check
 *  -------------------------- */
app.get("/", (req, res) => {
  res.json({ message: "Catan API is running!", version: "1.0.0", activeGames: games.size });
});

/** --------------------------
 *  Create game
 *  -------------------------- */
app.post("/api/games", (req, res) => {
  const { numPlayers = 4, playerConfigs = [] } = req.body || {};
  const game = new CatanGame({ numPlayers, playerConfigs });
  games.set(game.id, game);
  res.json({ ok: true, id: game.id, state: game.getState() });
});

app.get("/api/games/:id", (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });
  res.json(game.getState());
});

/** Manual action */
app.post("/api/games/:id/actions", (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  try {
    const { action, payload } = req.body || {};
    const applied = applyActionSafely(game, { action, payload });
    res.json({ ok: true, action: applied.actionObj, event: applied.event, state: game.getState() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** --------------------------
 *  LLM turn (FINISHES the turn with multiple actions)
 *  -------------------------- */
app.post("/api/games/:id/llm-turn", async (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  try {
    const { model, provider, notes, autoApply = true, apiKey, apiEndpoint } = req.body || {};

    const agentConfig = typeof game.getPlayerAgent === "function" ? game.getPlayerAgent(game.current) : null;
    if (!agentConfig || agentConfig.type !== "llm") {
      return res.status(400).json({ ok: false, error: "Current player is not an LLM agent." });
    }

    const algorithmMode = agentConfig.algorithmMode || "llm_only";
    const algorithm = agentConfig.algorithm || "none";
    const algorithmParams = agentConfig.algorithmParams || {};

    const llmConfig = {
      ...agentConfig,
      provider: provider || agentConfig.provider || "openai",
      model: model || agentConfig.model || DEFAULT_MODEL,
      apiKey: apiKey || agentConfig.apiKey,
      apiEndpoint: normalizeEndpoint(
        provider || agentConfig.provider || "openai",
        apiEndpoint || agentConfig.apiEndpoint
      ),
    };
    llmConfig.apiKey = resolveApiKey(llmConfig);

    const startPlayerIndex = game.current;
    const appliedActions = [];

    for (let step = 0; step < MAX_ACTIONS_PER_TURN; step++) {
      const stateBefore = game.getState();
      if (stateBefore.winner) break;
      if (game.current !== startPlayerIndex) break;

      let rawActionObj;

      if (algorithmMode === "algo_only") {
        try {
          rawActionObj = pickAlgorithmAction(game, { algorithm, params: algorithmParams });
        } catch (e) {
          rawActionObj = { action: "endTurn", payload: {}, reason: `Algorithm error: ${e.message}` };
        }

        if (shouldOverrideLLM(game, rawActionObj)) rawActionObj = strategicBestAction(game);
        if (!rawActionObj) rawActionObj = { action: "endTurn", payload: {}, reason: "Algorithm produced no action." };
      } else {
        let lastError = null;
        let got = null;

        for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
          try {
            const augmentedNotes = [notes, lastError ? `Previous error: ${lastError}` : null]
              .filter(Boolean)
              .join("\n");
            got = await getLLMAction(game, { llmConfig, notes: augmentedNotes });
            break;
          } catch (e) {
            lastError = e.message;
          }
        }

        rawActionObj = got || { action: "endTurn", payload: {}, reason: "LLM failed repeatedly." };
      }

      rawActionObj = sanitizeActionObj(rawActionObj);

      if (autoApply === false) {
        return res.json({ ok: true, action: rawActionObj, state: game.getState() });
      }

      if (shouldOverrideLLM(game, rawActionObj)) rawActionObj = strategicBestAction(game);

      const applied = applyActionSafely(game, rawActionObj);
      appliedActions.push(applied.actionObj);

      console.log("AI applied:", {
        action: applied.actionObj.action,
        payload: applied.actionObj.payload,
        reason: applied.actionObj.reason,
      });

      if (applied.actionObj.action === "endTurn") break;
      if (game.current !== startPlayerIndex) break;
    }

    res.json({ ok: true, actions: appliedActions, state: game.getState() });
  } catch (err) {
    console.error("LLM/AI turn failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Verify API key */
app.post("/api/llm/verify-key", async (req, res) => {
  const { provider, apiKey, apiEndpoint } = req.body || {};
  if (!provider) return res.status(400).json({ ok: false, error: "Provider is required for verification." });

  const requiresKey = provider !== "ollama";
  if (requiresKey && !apiKey) return res.status(400).json({ ok: false, error: "API key is required for this provider." });

  try {
    const result = await verifyApiKey(provider, apiKey, apiEndpoint);
    if (result.ok) return res.json({ ok: true, status: result.status, message: "Provider accepted the credentials." });

    return res.status(result.status === 401 ? 401 : 400).json({
      ok: false,
      error: result.status === 401 ? "Provider rejected API key." : `Verification failed (${result.status})`,
      detail: result.detail,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Unable to verify API key.", detail: err.message });
  }
});

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Catan API listening on http://localhost:${PORT}`));
}

module.exports = { app, games, performAction };
