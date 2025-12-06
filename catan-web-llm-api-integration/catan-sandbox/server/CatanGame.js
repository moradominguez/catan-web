// server/CatanGame.js (full rules engine, server-side source of truth)
const crypto = require("crypto");
const { generateBoard } = require("../shared/board.cjs");
const { resolveApiKey } = require("./llmAgent");

// ----- Constants shared with the front-end (duplicated here for now) -----

const BUILDING_COSTS = {
  road: { wood: 1, brick: 1 },
  town: { wood: 1, brick: 1, wheat: 1, sheep: 1 },
  city: { wheat: 2, ore: 3 }, // upgrade cost from town
};

// Development card deck (25 cards total)
const DEV_CARD_DECK = [
  // Victory Point cards (5)
  "victory",
  "victory",
  "victory",
  "victory",
  "victory",
  // Knight cards (14)
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  "knight",
  // Road Building (2)
  "road-building",
  "road-building",
  // Year of Plenty (2)
  "year-of-plenty",
  "year-of-plenty",
  // Monopoly (2)
  "monopoly",
  "monopoly",
];

const DEV_CARD_COST = { sheep: 1, wheat: 1, ore: 1 };

// ----- Helper functions (pure) -----

function canAfford(resources, cost) {
  return Object.entries(cost).every(
    ([resource, amount]) => (resources[resource] || 0) >= amount
  );
}

function deductResources(resources, cost) {
  const newResources = { ...resources };
  Object.entries(cost).forEach(([resource, amount]) => {
    newResources[resource] = (newResources[resource] || 0) - amount;
  });
  return newResources;
}

function addResources(resources, gains) {
  const newResources = { ...resources };
  Object.entries(gains).forEach(([resource, amount]) => {
    newResources[resource] = (newResources[resource] || 0) + amount;
  });
  return newResources;
}

function calculateVP(player, board) {
  let vp = 0;

  // Towns and cities
  board.nodes.forEach((node) => {
    if (node.building && node.building.ownerId === player.id) {
      vp += node.building.type === "town" ? 1 : 2;
    }
  });

  // Longest road / largest army
  if (player.longestRoad) vp += 2;
  if (player.largestArmy) vp += 2;

  // Victory dev cards
  if (player.devCards) {
    vp += player.devCards.filter((c) => c.type === "victory").length;
  }

  return vp;
}

function checkWinner(players) {
  return players.find((p) => p.vp >= 10) || null;
}

function calculateLongestRoad(playerId, edges /*, nodes */) {
  const playerEdges = edges.filter((e) => e.ownerId === playerId);
  if (playerEdges.length < 5) return 0;

  // Build adjacency map for player's roads
  const roadGraph = new Map();
  playerEdges.forEach((edge) => {
    if (!roadGraph.has(edge.n1)) roadGraph.set(edge.n1, []);
    if (!roadGraph.has(edge.n2)) roadGraph.set(edge.n2, []);
    roadGraph.get(edge.n1).push(edge.n2);
    roadGraph.get(edge.n2).push(edge.n1);
  });

  // DFS longest simple path (node-visited approximation)
  let maxLength = 0;

  function dfs(nodeId, visited, length) {
    maxLength = Math.max(maxLength, length);
    const neighbors = roadGraph.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        dfs(neighbor, visited, length + 1);
        visited.delete(neighbor);
      }
    }
  }

  roadGraph.forEach((_, startNode) => {
    const visited = new Set([startNode]);
    dfs(startNode, visited, 0);
  });

  return maxLength;
}

function updateLongestRoad(players, edges, nodes) {
  const roadLengths = players.map((player) => ({
    id: player.id,
    length: calculateLongestRoad(player.id, edges, nodes),
  }));

  const maxLength = Math.max(...roadLengths.map((r) => r.length));
  if (!isFinite(maxLength) || maxLength < 5) {
    return players.map((p) => ({ ...p, longestRoad: false }));
  }

  const playersWithMax = roadLengths.filter((r) => r.length === maxLength);
  if (playersWithMax.length > 1) {
    const currentHolder = players.find((p) => p.longestRoad);
    if (
      currentHolder &&
      playersWithMax.some((r) => r.id === currentHolder.id)
    ) {
      return players.map((p) => ({
        ...p,
        longestRoad: p.id === currentHolder.id,
      }));
    }
    return players.map((p) => ({ ...p, longestRoad: false }));
  }

  const winnerId = playersWithMax[0].id;
  return players.map((p) => ({ ...p, longestRoad: p.id === winnerId }));
}

function updateLargestArmy(players) {
  const maxKnights = Math.max(...players.map((p) => p.knightsPlayed));
  if (!isFinite(maxKnights) || maxKnights < 3) {
    return players.map((p) => ({ ...p, largestArmy: false }));
  }

  const playersWithMax = players.filter(
    (p) => p.knightsPlayed === maxKnights
  );
  if (playersWithMax.length > 1) {
    const currentHolder = players.find((p) => p.largestArmy);
    if (
      currentHolder &&
      playersWithMax.some((p) => p.id === currentHolder.id)
    ) {
      return players.map((p) => ({
        ...p,
        largestArmy: p.id === currentHolder.id,
      }));
    }
    return players.map((p) => ({ ...p, largestArmy: false }));
  }

  const winnerId = playersWithMax[0].id;
  return players.map((p) => ({ ...p, largestArmy: p.id === winnerId }));
}

// Harbor helpers: guard harbors array safely
function getPlayerTradingRatios(playerId, nodes) {
  const ratios = { default: 4 }; // 4:1 base

  nodes.forEach((node) => {
    if (node.building && node.building.ownerId === playerId) {
      const harbors = Array.isArray(node.harbors) ? node.harbors : [];
      harbors.forEach((harbor) => {
        if (!harbor) return;
        if (harbor.resource === "any") {
          ratios.default = Math.min(ratios.default, harbor.ratio);
        } else {
          ratios[harbor.resource] = Math.min(
            ratios[harbor.resource] || 4,
            harbor.ratio
          );
        }
      });
    }
  });

  return ratios;
}

function getBestTradingRatio(playerId, resource, nodes) {
  const ratios = getPlayerTradingRatios(playerId, nodes);
  return ratios[resource] || ratios.default;
}

// Simple shuffle
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normalize the “algorithm” settings coming from the new UI
function normalizeAlgoConfig(cfg = {}) {
  // New UI fields:
  // algorithmMode: "none" | "llm_only" | "algo_only" | "llm_plus_algo"
  // algorithm: "none" | "mcts" | "minimax" | "hybrid" (etc)
  // algorithmParams: object
  const algorithmMode = cfg.algorithmMode || "llm_only";
  const algorithm = cfg.algorithm || "none";
  const algorithmParams =
    cfg.algorithmParams && typeof cfg.algorithmParams === "object"
      ? cfg.algorithmParams
      : {};

  // Back-compat for older ids like "llm-only"
  const normalizedAlgorithm =
    algorithm === "llm-only" ? "none" : algorithm;

  const normalizedMode =
    cfg.algorithmMode ||
    (cfg.algorithm &&
      cfg.algorithm !== "none" &&
      cfg.algorithm !== "llm-only"
      ? "llm_plus_algo"
      : "llm_only");

  return {
    algorithmMode: normalizedMode,
    algorithm: normalizedAlgorithm,
    algorithmParams,
  };
}

function normalizeModelName(requestedModel) {
  const m = requestedModel || "gpt-4o";
  return typeof m === "string" && m.toLowerCase().includes("gpt-4o")
    ? "gpt-4o"
    : m;
}

function normalizeApiKey(config) {
  const direct = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (direct) return direct;
  const resolved = resolveApiKey({
    ...config,
    provider: config.provider || "openai",
  });
  return typeof resolved === "string" ? resolved.trim() : "";
}

// ----- CatanGame class -----

class CatanGame {
  constructor({ numPlayers = 4, playerConfigs = [] } = {}) {
    this.id = crypto.randomUUID();
    this.numPlayers = numPlayers;
    this.board = generateBoard();

    // Store both:
    // - playerAgents (used by /llm-turn to decide provider/model/keys + algorithm routing)
    // - players (state returned to UI)
    this.playerAgents = this._buildPlayerAgents(numPlayers, playerConfigs);
    this.players = this._initPlayers(numPlayers, playerConfigs);

    this.current = 0;
    this.turn = 1;
    this.robberMovedThisTurn = false;
    this.lastRoll = null;
    this.lastProduction = null;
    this.devCardDeck = shuffle(DEV_CARD_DECK);
    this.log = [];

    this._placeInitialBuildings();
    this._recalculateVP();
  }

  // ----- internal helpers -----

  // Build agent configs used by /api/games/:id/llm-turn
  _buildPlayerAgents(numPlayers, playerConfigs = []) {
    return Array.from({ length: numPlayers }, (_, i) => {
      const cfg = playerConfigs[i] || {};
      if (cfg.type !== "llm") return null;

      const algo = normalizeAlgoConfig(cfg);
      const isAlgoOnly = algo.algorithmMode === "algo_only";

      const provider = isAlgoOnly
        ? "algorithm"
        : cfg.provider || "openai";
      const providerName = isAlgoOnly
        ? "Algorithm"
        : cfg.providerName || provider || "AI";
      const model = isAlgoOnly
        ? algo.algorithm || "heuristic"
        : normalizeModelName(cfg.model);

      // For pure algorithm agents, no API key is needed.
      const apiKey = isAlgoOnly
        ? ""
        : normalizeApiKey({ ...cfg, provider });

      return {
        playerId: i,
        type: "llm",

        provider,
        providerName,
        providerCategory: cfg.providerCategory || null,
        model,
        apiKey,
        apiEndpoint: cfg.apiEndpoint || null,

        algorithmMode: algo.algorithmMode,
        algorithm: algo.algorithm,
        algorithmParams: algo.algorithmParams,
      };
    });
  }

  _initPlayers(numPlayers, playerConfigs = []) {
    const colors = ["#1976d2", "#e53935", "#8e24aa", "#ef6c00"];

    return Array.from({ length: numPlayers }, (_, i) => {
      const cfg = playerConfigs[i] || {};
      const isAI = cfg.type === "llm";

      const algo = normalizeAlgoConfig(cfg);
      const isAlgoOnly = isAI && algo.algorithmMode === "algo_only";

      const provider = isAI
        ? isAlgoOnly
          ? "algorithm"
          : cfg.provider || "openai"
        : null;
      const providerName = isAI
        ? isAlgoOnly
          ? "Algorithm"
          : cfg.providerName || provider || "AI"
        : null;
      const providerModel = isAI
        ? isAlgoOnly
          ? algo.algorithm || "heuristic"
          : normalizeModelName(cfg.model)
        : null;

      return {
        id: i,
        name:
          cfg.name ||
          (isAI && providerName ? providerName : `Player ${i + 1}`),
        color: colors[i],

        // Keeping your existing shape so UI doesn’t break:
        model: isAI ? "ai" : "human",
        type: cfg.type || "human",

        provider,
        providerName,
        providerModel,
        providerCategory: cfg.providerCategory || null,

        // Expose algorithm fields in state for UI/debug
        algorithmMode: isAI ? algo.algorithmMode : "none",
        algorithm: isAI ? algo.algorithm : "none",
        algorithmParams: isAI ? algo.algorithmParams : {},

        resources: { wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 1 },
        vp: 0,
        victoryPoints: 0,

        devCards: [],
        playedDevCards: [],
        knightsPlayed: 0,
        largestArmy: false,
        longestRoad: false,

        boughtDevCardThisTurn: false,
        hasRolled: false,

        towns: 0,
        cities: 0,
        roads: 0,
        trades: 0,
      };
    });
  }

  _placeInitialBuildings() {
    const { nodes, edges, tiles } = this.board;

    const desertTileIndices = tiles
      .map((tile, index) => (tile.resource === "desert" ? index : -1))
      .filter((index) => index !== -1);

    const availableNodes = nodes.filter((n) => {
      if (n.building) return false;
      if (!n.canBuild) return false;
      const adj = Array.isArray(n.adjHexes) ? n.adjHexes : [];
      const isAdjacentToDesert = adj.some((hexIdx) =>
        desertTileIndices.includes(hexIdx)
      );
      return !isAdjacentToDesert;
    });

    for (let playerId = 0; playerId < this.numPlayers; playerId++) {
      for (let settlement = 0; settlement < 2; settlement++) {
        if (availableNodes.length === 0) break;

        const randomIndex = Math.floor(Math.random() * availableNodes.length);
        const selectedNode = availableNodes[randomIndex];
        const nodeId = selectedNode.id;

        // Place town (free)
        selectedNode.building = { ownerId: playerId, type: "town" };
        availableNodes.splice(randomIndex, 1);

        // Place a connected road (free)
        const connectedEdges = edges.filter((e) => {
          if (e.ownerId != null) return false;
          const isConnected = e.n1 === nodeId || e.n2 === nodeId;
          if (!isConnected) return false;
          const node1 = nodes.find((n) => n.id === e.n1);
          const node2 = nodes.find((n) => n.id === e.n2);
          return !!(node1?.canBuild && node2?.canBuild);
        });

        if (connectedEdges.length > 0) {
          const randomEdgeIndex = Math.floor(
            Math.random() * connectedEdges.length
          );
          connectedEdges[randomEdgeIndex].ownerId = playerId;
        }

        // Enforce spacing: remove adjacent nodes from availability
        const adjacentNodeIds = edges
          .filter((e) => e.n1 === nodeId || e.n2 === nodeId)
          .flatMap((e) => [e.n1, e.n2])
          .filter((id) => id !== nodeId);

        for (let i = availableNodes.length - 1; i >= 0; i--) {
          if (adjacentNodeIds.includes(availableNodes[i].id)) {
            availableNodes.splice(i, 1);
          }
        }
      }
    }
  }

  _emit(event) {
    const full = { timestamp: new Date().toISOString(), ...event };
    this.log.push(full);
    return full;
  }

  _recalculateVP() {
    this.players = this.players.map((p) => {
      const vp = calculateVP(p, this.board);
      return { ...p, vp, victoryPoints: vp };
    });
  }

  _derivePlayerStats() {
    const stats = this.players.map(() => ({ towns: 0, cities: 0, roads: 0 }));

    this.board.nodes.forEach((node) => {
      if (!node.building) return;
      const owner = node.building.ownerId;
      if (owner == null || !stats[owner]) return;
      if (node.building.type === "town") stats[owner].towns += 1;
      if (node.building.type === "city") stats[owner].cities += 1;
    });

    this.board.edges.forEach((edge) => {
      if (edge.ownerId == null) return;
      if (stats[edge.ownerId]) stats[edge.ownerId].roads += 1;
    });

    return stats;
  }

  _requireRoll(playerId) {
    const player = this.players[playerId];
    if (!player.hasRolled) {
      throw new Error("You must roll the dice before building or trading!");
    }
  }

  _awardProduction(rollTotal) {
    const tiles = this.board.tiles;
    const nodes = this.board.nodes;

    const newPlayers = this.players.map((p) => ({
      ...p,
      resources: { ...p.resources },
    }));

    const productionTracking = {};

    tiles.forEach((tile, hexIdx) => {
      if (tile.hasRobber) return;
      if (tile.number !== rollTotal) return;
      const resource = tile.resource;
      if (!resource || resource === "desert" || resource === "water") return;

      nodes.forEach((node) => {
        if (node.building && (node.adjHexes || []).includes(hexIdx)) {
          const amt = node.building.type === "city" ? 2 : 1;
          const owner = node.building.ownerId;

          newPlayers[owner].resources[resource] =
            (newPlayers[owner].resources[resource] || 0) + amt;

          if (!productionTracking[owner]) productionTracking[owner] = {};
          productionTracking[owner][resource] =
            (productionTracking[owner][resource] || 0) + amt;
        }
      });
    });

    this.players = newPlayers;

    this.lastProduction = {
      rollTotal,
      players: Object.entries(productionTracking).map(
        ([playerId, resources]) => {
          const p = this.players[Number(playerId)];
          return {
            playerId: p.id,
            playerName: p.name,
            playerColor: p.color,
            resources: Object.entries(resources).map(
              ([resource, amount]) => ({ resource, amount })
            ),
          };
        }
      ),
    };
  }

  // ----- public API -----

  getState() {
    const derived = this._derivePlayerStats();

    const players = this.players.map((p, idx) => ({
      ...p,
      towns: derived[idx]?.towns ?? p.towns ?? 0,
      cities: derived[idx]?.cities ?? p.cities ?? 0,
      roads: derived[idx]?.roads ?? p.roads ?? 0,
      devCardCount: p.devCards?.length || 0,
      victoryPoints: p.victoryPoints ?? p.vp,
    }));

    return {
      id: this.id,
      numPlayers: this.numPlayers,
      board: this.board,
      players,
      current: this.current,
      turn: this.turn,
      lastRoll: this.lastRoll,
      lastProduction: this.lastProduction,
      winner: checkWinner(this.players),
    };
  }

  getPlayerAgent(playerId) {
    if (!this.playerAgents) return null;
    return this.playerAgents[playerId] || null;
  }

  // Return a structured list of legal actions for the current state.
  getLegalActions(playerId = this.current) {
    const legal = {
      rollDice: [],
      endTurn: [{}],
      buildTown: [],
      buildCity: [],
      buildRoad: [],
      moveRobber: [],
      buyDevCard: [],
      harborTrade: [],
    };

    const player = this.players[playerId];
    if (!player) return legal;

    // if not rolled -> only roll + endTurn
    if (!player.hasRolled) {
      legal.rollDice.push({});
      return legal;
    }

    // robber targets: any tile except current robber
    for (let hexId = 0; hexId < (this.board.tiles?.length || 0); hexId++) {
      const t = this.board.tiles[hexId];
      if (!t) continue;
      if (!t.hasRobber) legal.moveRobber.push({ hexId });
    }

    // buy dev card
    if (
      canAfford(player.resources, DEV_CARD_COST) &&
      this.devCardDeck?.length
    ) {
      legal.buyDevCard.push({});
    }

    // build city: upgrade your own towns
    for (let nodeId = 0; nodeId < (this.board.nodes?.length || 0); nodeId++) {
      const node = this.board.nodes[nodeId];
      if (!node?.building) continue;
      if (node.building.ownerId !== playerId) continue;
      if (node.building.type !== "town") continue;
      if (canAfford(player.resources, BUILDING_COSTS.city)) {
        legal.buildCity.push({ nodeId });
      }
    }

    // build town
    if (canAfford(player.resources, BUILDING_COSTS.town)) {
      for (let nodeId = 0; nodeId < (this.board.nodes?.length || 0); nodeId++) {
        const node = this.board.nodes[nodeId];
        if (!node) continue;
        if (!node.canBuild) continue;
        if (node.building) continue;

        const neighborNodeIds = this.board.edges
          .filter((e) => e.n1 === nodeId || e.n2 === nodeId)
          .flatMap((e) => [e.n1, e.n2])
          .filter((id) => id !== nodeId);

        const neighborOccupied = neighborNodeIds.some(
          (id) => this.board.nodes[id] && this.board.nodes[id].building
        );
        if (neighborOccupied) continue;

        legal.buildTown.push({ nodeId });
      }
    }

    // build road
    if (canAfford(player.resources, BUILDING_COSTS.road)) {
      for (let edgeId = 0; edgeId < (this.board.edges?.length || 0); edgeId++) {
        const edge = this.board.edges[edgeId];
        if (!edge) continue;
        if (edge.ownerId != null) continue;

        const node1 = this.board.nodes[edge.n1];
        const node2 = this.board.nodes[edge.n2];

        const playerConnected =
          (node1?.building && node1.building.ownerId === playerId) ||
          (node2?.building && node2.building.ownerId === playerId) ||
          this.board.edges.some(
            (e) =>
              e.ownerId === playerId &&
              (e.n1 === edge.n1 ||
                e.n1 === edge.n2 ||
                e.n2 === edge.n1 ||
                e.n2 === edge.n2)
          );

        if (!playerConnected) continue;
        if (!node1?.canBuild && !node2?.canBuild) continue;

        legal.buildRoad.push({ edgeId });
      }
    }

    return legal;
  }

  // ----- Turn / dice / robber -----

  rollDice() {
    const currentPlayer = this.players[this.current];

    if (currentPlayer.hasRolled) {
      throw new Error("You already rolled this turn!");
    }

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const total = d1 + d2;

    this.lastRoll = { d1, d2, total };

    // mark rolled for current player
    this.players = this.players.map((p) =>
      p.id === this.current ? { ...p, hasRolled: true } : p
    );

    if (total !== 7) {
      this._awardProduction(total);
    }

    return this._emit({ type: "rollDice", d1, d2, total });
  }

  moveRobber(hexId) {
    if (this.robberMovedThisTurn) {
      throw new Error("Robber already moved this turn.");
    }

    const tiles = this.board.tiles.map((t, i) => ({
      ...t,
      hasRobber: i === hexId,
    }));
    this.board = { ...this.board, tiles };
    this.robberMovedThisTurn = true;
    return this._emit({ type: "moveRobber", hexId });
  }

  // ----- Building -----

  buildRoad(edgeId, playerId = this.current, opts = { free: false }) {
    if (!opts.free) this._requireRoll(playerId);

    const board = this.board;
    const edge = board.edges[edgeId];
    if (!edge) throw new Error("Invalid edge");
    if (edge.ownerId != null) throw new Error("Edge already taken");

    const node1 = board.nodes[edge.n1];
    const node2 = board.nodes[edge.n2];

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const playerConnected =
      (node1.building && node1.building.ownerId === playerId) ||
      (node2.building && node2.building.ownerId === playerId) ||
      board.edges.some(
        (e) =>
          e.ownerId === playerId &&
          (e.n1 === edge.n1 ||
            e.n1 === edge.n2 ||
            e.n2 === edge.n1 ||
            e.n2 === edge.n2)
      );

    if (!playerConnected) {
      throw new Error(
        "Road must connect to your building or existing road"
      );
    }

    if (!node1.canBuild && !node2.canBuild) {
      throw new Error("Cannot build road here - no adjacent land");
    }

    const cost = BUILDING_COSTS.road;
    if (!opts.free && !canAfford(player.resources, cost)) {
      throw new Error("Not enough resources for road");
    }

    const updatedPlayer = {
      ...player,
      resources: opts.free
        ? player.resources
        : deductResources(player.resources, cost),
    };

    const newEdges = board.edges.slice();
    newEdges[edgeId] = { ...edge, ownerId: playerId };

    let newPlayers = this.players.map((p) =>
      p.id === playerId ? updatedPlayer : p
    );

    newPlayers = updateLongestRoad(newPlayers, newEdges, board.nodes);
    this.players = newPlayers;
    this.board = { ...board, edges: newEdges };
    this._recalculateVP();

    return this._emit({ type: "buildRoad", playerId, edgeId });
  }

  buildTown(nodeId, playerId = this.current) {
    this._requireRoll(playerId);

    const board = this.board;
    const node = board.nodes[nodeId];
    if (!node) throw new Error("Invalid node");

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const cost = BUILDING_COSTS.town;

    if (!node.canBuild)
      throw new Error("Cannot build here - no adjacent land");
    if (node.building) throw new Error("Node already has a building");

    const neighborNodeIds = board.edges
      .filter((e) => e.n1 === nodeId || e.n2 === nodeId)
      .flatMap((e) => [e.n1, e.n2])
      .filter((id) => id !== nodeId);

    const neighborOccupied = neighborNodeIds.some(
      (id) => board.nodes[id] && board.nodes[id].building
    );
    if (neighborOccupied)
      throw new Error("Too close to another town/city");
    if (!canAfford(player.resources, cost))
      throw new Error("Not enough resources for town");

    const updatedPlayer = {
      ...player,
      resources: deductResources(player.resources, cost),
    };

    const newNodes = board.nodes.slice();
    newNodes[nodeId] = {
      ...node,
      building: { ownerId: playerId, type: "town" },
    };

    this.players = this.players.map((p) =>
      p.id === playerId ? updatedPlayer : p
    );
    this.board = { ...board, nodes: newNodes };
    this._recalculateVP();

    return this._emit({ type: "buildTown", playerId, nodeId });
  }

  buildCity(nodeId, playerId = this.current) {
    this._requireRoll(playerId);

    const board = this.board;
    const node = board.nodes[nodeId];
    if (!node) throw new Error("Invalid node");
    if (!node.building || node.building.ownerId !== playerId) {
      throw new Error("Must upgrade your own town");
    }
    if (node.building.type !== "town") {
      throw new Error("Can only upgrade a town to a city");
    }

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const cost = BUILDING_COSTS.city;
    if (!canAfford(player.resources, cost))
      throw new Error("Not enough resources for city");

    const updatedPlayer = {
      ...player,
      resources: deductResources(player.resources, cost),
    };

    const newNodes = board.nodes.slice();
    newNodes[nodeId] = {
      ...node,
      building: { ownerId: playerId, type: "city" },
    };

    this.players = this.players.map((p) =>
      p.id === playerId ? updatedPlayer : p
    );
    this.board = { ...board, nodes: newNodes };
    this._recalculateVP();

    return this._emit({ type: "buildCity", playerId, nodeId });
  }

  // ----- Trading -----

  tradeHarbor(playerId, giveResource, receiveResource) {
    this._requireRoll(playerId);

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const ratio = getBestTradingRatio(
      playerId,
      giveResource,
      this.board.nodes
    );
    if ((player.resources[giveResource] || 0) < ratio) {
      throw new Error(`Not enough ${giveResource} to trade`);
    }

    const newResources = { ...player.resources };
    newResources[giveResource] =
      (newResources[giveResource] || 0) - ratio;
    newResources[receiveResource] =
      (newResources[receiveResource] || 0) + 1;

    this.players = this.players.map((p) =>
      p.id === playerId
        ? {
            ...p,
            resources: newResources,
            trades: (p.trades || 0) + 1,
          }
        : p
    );

    return this._emit({
      type: "harborTrade",
      playerId,
      giveResource,
      receiveResource,
      ratio,
    });
  }

  // ----- Dev cards -----

  buyDevCard(playerId = this.current) {
    this._requireRoll(playerId);
    if (!this.devCardDeck.length)
      throw new Error("No development cards left");

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");
    if (!canAfford(player.resources, DEV_CARD_COST))
      throw new Error("Not enough resources for dev card");

    const cardType = this.devCardDeck.pop();
    const updatedPlayer = {
      ...player,
      resources: deductResources(player.resources, DEV_CARD_COST),
      devCards: [...player.devCards, { type: cardType, canPlay: false }],
      boughtDevCardThisTurn: true,
    };

    this.players = this.players.map((p) =>
      p.id === playerId ? updatedPlayer : p
    );
    this._recalculateVP();

    return this._emit({ type: "buyDevCard", playerId, cardType });
  }

  playKnight(playerId = this.current) {
    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const idx = player.devCards.findIndex(
      (c) => c.type === "knight" && c.canPlay
    );
    if (idx === -1) throw new Error("No playable Knight card");

    const newDevCards = player.devCards.filter((_, i) => i !== idx);

    let newPlayers = this.players.map((p) =>
      p.id === playerId
        ? {
            ...p,
            devCards: newDevCards,
            playedDevCards: [...p.playedDevCards, "knight"],
            knightsPlayed: p.knightsPlayed + 1,
          }
        : p
    );

    newPlayers = updateLargestArmy(newPlayers);
    this.players = newPlayers;
    this._recalculateVP();

    return this._emit({ type: "playKnight", playerId });
  }

  playYearOfPlenty(playerId = this.current, resource1, resource2) {
    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const idx = player.devCards.findIndex(
      (c) => c.type === "year-of-plenty" && c.canPlay
    );
    if (idx === -1) throw new Error("No playable Year of Plenty card");

    const newDevCards = player.devCards.filter((_, i) => i !== idx);
    const newResources = addResources(player.resources, {
      [resource1]: 1,
      [resource2]: 1,
    });

    this.players = this.players.map((p) =>
      p.id === playerId
        ? {
            ...p,
            devCards: newDevCards,
            playedDevCards: [...p.playedDevCards, "year-of-plenty"],
            resources: newResources,
          }
        : p
    );

    return this._emit({
      type: "playYearOfPlenty",
      playerId,
      resource1,
      resource2,
    });
  }

  playMonopoly(playerId = this.current, resource) {
    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const idx = player.devCards.findIndex(
      (c) => c.type === "monopoly" && c.canPlay
    );
    if (idx === -1) throw new Error("No playable Monopoly card");

    let totalStolen = 0;
    const intermediate = this.players.map((p) => {
      if (p.id === playerId) return p;
      const amount = p.resources[resource] || 0;
      totalStolen += amount;
      return {
        ...p,
        resources: { ...p.resources, [resource]: 0 },
      };
    });

    const updatedPlayer = intermediate.find((p) => p.id === playerId);
    const newDevCards = updatedPlayer.devCards.filter(
      (_, i) => i !== idx
    );
    const newResources = {
      ...updatedPlayer.resources,
      [resource]:
        (updatedPlayer.resources[resource] || 0) + totalStolen,
    };

    this.players = intermediate.map((p) =>
      p.id === playerId
        ? {
            ...p,
            devCards: newDevCards,
            playedDevCards: [...p.playedDevCards, "monopoly"],
            resources: newResources,
          }
        : p
    );

    this._recalculateVP();

    return this._emit({
      type: "playMonopoly",
      playerId,
      resource,
      totalStolen,
    });
  }

  playRoadBuilding(playerId = this.current) {
    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const idx = player.devCards.findIndex(
      (c) => c.type === "road-building" && c.canPlay
    );
    if (idx === -1) throw new Error("No playable Road Building card");

    const newDevCards = player.devCards.filter((_, i) => i !== idx);

    this.players = this.players.map((p) =>
      p.id === playerId
        ? {
            ...p,
            devCards: newDevCards,
            playedDevCards: [...p.playedDevCards, "road-building"],
          }
        : p
    );

    return this._emit({ type: "playRoadBuilding", playerId });
  }

  // ----- Turn end -----

  endTurn() {
    // make newly bought dev cards playable from next turn onward
    this.players = this.players.map((p) => ({
      ...p,
      devCards: (p.devCards || []).map((card) => ({
        ...card,
        canPlay: true,
      })),
      boughtDevCardThisTurn: false,
      hasRolled: false,
    }));

    this.current = this.players.length
      ? (this.current + 1) % this.players.length
      : 0;
    this.turn += 1;
    this.robberMovedThisTurn = false;

    return this._emit({ type: "endTurn", nextPlayer: this.current });
  }
}

module.exports = { CatanGame };
