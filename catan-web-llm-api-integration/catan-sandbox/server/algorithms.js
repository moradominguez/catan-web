// server/algorithms.js
// Pragmatic "MCTS-inspired" heuristic agent:
// - Not a full game-tree search (too complex for full Catan),
// - But DOES use expected value (dice probability) + resource values,
// - Picks best City/Settlement/Road placements by board scoring,
// - Handles mandatory robber move after rolling a 7,
// - Never throws "not implemented".

const RES_ALIASES = {
    wood: "lumber",
    lumber: "lumber",
    brick: "brick",
    clay: "brick",
    wheat: "grain",
    grain: "grain",
    sheep: "wool",
    wool: "wool",
    ore: "ore",
  };
  
  function normResKey(k) {
    const key = String(k || "").toLowerCase();
    return RES_ALIASES[key] || key;
  }
  
  function getRes(player, key) {
    const k = normResKey(key);
    const r = player?.resources || {};
    // tolerate multiple key styles
    return Number(r[k] ?? r[key] ?? r[String(key)] ?? 0);
  }
  
  function canAfford(player, cost) {
    return Object.entries(cost).every(([k, v]) => getRes(player, k) >= v);
  }
  
  const COSTS = {
    road: { lumber: 1, brick: 1 },
    town: { lumber: 1, brick: 1, grain: 1, wool: 1 },
    city: { grain: 2, ore: 3 },
    dev: { grain: 1, wool: 1, ore: 1 },
  };
  
  // 2d6 probabilities
  const DICE_P = {
    2: 1 / 36,
    3: 2 / 36,
    4: 3 / 36,
    5: 4 / 36,
    6: 5 / 36,
    7: 0,
    8: 5 / 36,
    9: 4 / 36,
    10: 3 / 36,
    11: 2 / 36,
    12: 1 / 36,
  };
  
  // Resource value weights (tweakable)
  const RES_VALUE_SETTLEMENT = { lumber: 1.0, brick: 1.0, wool: 1.0, grain: 1.15, ore: 1.1 };
  const RES_VALUE_CITY = { lumber: 1.0, brick: 0.95, wool: 0.95, grain: 1.25, ore: 1.4 };
  
  function uniq(arr) {
    return [...new Set(arr.filter((x) => x !== undefined && x !== null))];
  }
  
  function toInt(v) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  
  function safePlayerId(game) {
    const p = game.players?.[game.current];
    return p?.id ?? game.current;
  }
  
  function getTileInfo(game, tileId) {
    const t = game.board?.tiles?.[tileId];
    if (!t) return null;
    const res = normResKey(t.resource);
    return { res, num: t.number, hasRobber: !!t.hasRobber };
  }
  
  // Expected production score for a node (settlement or city)
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
  
    let s = -Infinity;
    if (Number.isFinite(n1)) s = Math.max(s, nodeProductionScore(game, n1, "settlement"));
    if (Number.isFinite(n2)) s = Math.max(s, nodeProductionScore(game, n2, "settlement"));
  
    // small bonus if it touches a buildable node
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
    const t = (b.type ?? b.kind ?? b.name ?? (typeof b === "string" ? b : "")).toString().toLowerCase();
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
  
  // Candidate sets (these are "availability" candidates; legality is enforced by your applyActionSafely)
  function openNodeIds(game) {
    const nodes = game.board?.nodes || [];
    const ids = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      if (!n.building && n.canBuild) ids.push(i);
    }
    return uniq(ids);
  }
  
  function openEdgeIds(game) {
    const edges = game.board?.edges || [];
    const ids = [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e) continue;
      if (e.ownerId == null) ids.push(i);
    }
    return uniq(ids);
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
  
  function rankedTownNodeIds(game) {
    return openNodeIds(game)
      .map((nodeId) => ({ nodeId, score: nodeProductionScore(game, nodeId, "settlement") }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.nodeId);
  }
  
  function rankedCityNodeIds(game, playerId) {
    return upgradableSettlementNodeIds(game, playerId)
      .map((nodeId) => ({ nodeId, score: nodeProductionScore(game, nodeId, "city") }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.nodeId);
  }
  
  function rankedRoadEdgeIds(game) {
    return openEdgeIds(game)
      .map((edgeId) => ({ edgeId, score: edgeExpansionScore(game, edgeId) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.edgeId);
  }
  
  // Robber placement: block opponent expected production
  function robberBestHexId(game, currentPlayerId) {
    const tiles = game.board?.tiles || [];
    const nodes = game.board?.nodes || [];
  
    let best = null;
  
    for (let tileId = 0; tileId < tiles.length; tileId++) {
      const ti = getTileInfo(game, tileId);
      if (!ti) continue;
      if (ti.hasRobber) continue;
      if (!ti.num || ti.num === 7) continue;
  
      const p = DICE_P[ti.num] ?? 0;
      if (p <= 0) continue;
  
      let oppWeight = 0;
      let meWeight = 0;
  
      for (const n of nodes) {
        if (!n) continue;
        const adj = Array.isArray(n.adjHexes) ? n.adjHexes : [];
        if (!adj.includes(tileId)) continue;
        if (!n.building) continue;
  
        const owner = getBuildingOwnerId(n.building);
        const isCity = isCityBuilding(n.building);
        const w = isCity ? 2 : 1;
  
        if (owner === currentPlayerId) meWeight += w;
        else oppWeight += w;
      }
  
      // prefer blocking opponents; slightly avoid hurting self
      const score = p * (oppWeight - 0.65 * meWeight);
      if (best == null || score > best.score) best = { tileId, score };
    }
  
    // fallback to first non-robber tile
    return best?.tileId ?? Math.max(0, tiles.findIndex((t) => !t?.hasRobber));
  }
  
  function algoPolicy(game, { debug = false } = {}) {
    const player = game.players?.[game.current];
    if (!player) return { action: "endTurn", payload: {}, reason: "Algo: missing player." };
  
    const pid = safePlayerId(game);
  
    // 0) must roll first
    if (!player.hasRolled) {
      return { action: "rollDice", payload: {}, reason: "Algo: roll first." };
    }
  
    // 1) robber move after a 7 (best-effort)
    if (game.lastRoll === 7) {
      const hexId = robberBestHexId(game, pid);
      return {
        action: "moveRobber",
        payload: { hexId },
        reason: `Algo: rolled 7 → move robber to hex ${hexId} (block opponent EV).`,
      };
    }
  
    // 2) City if possible + has upgrade targets
    if (canAfford(player, COSTS.city)) {
      const cityNodes = rankedCityNodeIds(game, pid);
      if (cityNodes.length > 0) {
        const nodeId = cityNodes[0];
        const s = nodeProductionScore(game, nodeId, "city");
        return {
          action: "buildCity",
          payload: { nodeId },
          reason: `Algo: best City upgrade at node ${nodeId} (EV=${s.toFixed(4)}).`,
        };
      }
    }
  
    // 3) Settlement if possible + has open nodes
    if (canAfford(player, COSTS.town)) {
      const townNodes = rankedTownNodeIds(game);
      if (townNodes.length > 0) {
        const nodeId = townNodes[0];
        const s = nodeProductionScore(game, nodeId, "settlement");
        return {
          action: "buildTown",
          payload: { nodeId },
          reason: `Algo: best Settlement at node ${nodeId} (EV=${s.toFixed(4)}).`,
        };
      }
    }
  
    // 4) Road if possible + has edges
    if (canAfford(player, COSTS.road)) {
      const edges = rankedRoadEdgeIds(game);
      if (edges.length > 0) {
        const edgeId = edges[0];
        const s = edgeExpansionScore(game, edgeId);
        return {
          action: "buildRoad",
          payload: { edgeId },
          reason: `Algo: best Road edge ${edgeId} (expandScore=${s.toFixed(4)}).`,
        };
      }
    }
  
    // 5) Dev card if possible (fallback value)
    if (canAfford(player, COSTS.dev) && !player.boughtDevCardThisTurn) {
      return { action: "buyDevCard", payload: {}, reason: "Algo: buy Dev Card (no better build found)." };
    }
  
    if (debug) {
      // eslint-disable-next-line no-console
      console.log("[algo] pass; resources:", player.resources);
    }
  
    return { action: "endTurn", payload: {}, reason: "Algo: no strong/available action; end turn." };
  }
  
  // Public API used by server.js
  function pickAlgorithmAction(game, { algorithm = "mcts", params = {} } = {}) {
    const name = String(algorithm || "mcts").toLowerCase();
  
    // We map names to the same policy so you can select "mcts" or "minimax"
    // in configs without breaking demo.
    switch (name) {
      case "mcts":
      case "minimax":
      case "tree":
      case "heuristic":
      case "greedy":
        return algoPolicy(game, params);
  
      case "none":
      default:
        return algoPolicy(game, params);
    }
  }
  
  module.exports = { pickAlgorithmAction };
  