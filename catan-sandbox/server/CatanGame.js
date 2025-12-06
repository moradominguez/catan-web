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
  "victory", "victory", "victory", "victory", "victory",
  // Knight cards (14)
  "knight", "knight", "knight", "knight", "knight", "knight", "knight",
  "knight", "knight", "knight", "knight", "knight", "knight", "knight",
  // Road Building (2)
  "road-building", "road-building",
  // Year of Plenty (2)
  "year-of-plenty", "year-of-plenty",
  // Monopoly (2)
  "monopoly", "monopoly",
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

function calculateLongestRoad(playerId, edges, nodes) {
  // Find all roads owned by this player
  const playerEdges = edges.filter((e) => e.ownerId === playerId);
  if (playerEdges.length < 5) return 0; // Need at least 5 roads for longest road

  // Build adjacency map for player's roads
  const roadGraph = new Map();
  playerEdges.forEach((edge) => {
    if (!roadGraph.has(edge.n1)) roadGraph.set(edge.n1, []);
    if (!roadGraph.has(edge.n2)) roadGraph.set(edge.n2, []);
    roadGraph.get(edge.n1).push(edge.n2);
    roadGraph.get(edge.n2).push(edge.n1);
  });

  // DFS to find longest simple path in this road graph
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
    // No one has longest road
    return players.map((p) => ({ ...p, longestRoad: false }));
  }

  const playersWithMax = roadLengths.filter((r) => r.length === maxLength);
  if (playersWithMax.length > 1) {
    const currentHolder = players.find((p) => p.longestRoad);
    if (currentHolder && playersWithMax.some((r) => r.id === currentHolder.id)) {
      return players.map((p) => ({ ...p, longestRoad: p.id === currentHolder.id }));
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

  const playersWithMax = players.filter((p) => p.knightsPlayed === maxKnights);
  if (playersWithMax.length > 1) {
    const currentHolder = players.find((p) => p.largestArmy);
    if (currentHolder && playersWithMax.some((p) => p.id === currentHolder.id)) {
      return players.map((p) => ({ ...p, largestArmy: p.id === currentHolder.id }));
    }
    return players.map((p) => ({ ...p, largestArmy: false }));
  }

  const winnerId = playersWithMax[0].id;
  return players.map((p) => ({ ...p, largestArmy: p.id === winnerId }));
}

// Harbor helpers: same logic as front-end
function getPlayerTradingRatios(playerId, nodes) {
  const ratios = { default: 4 }; // 4:1 base

  nodes.forEach((node) => {
    if (node.building && node.building.ownerId === playerId) {
      node.harbors.forEach((harbor) => {
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

// ----- CatanGame class -----

class CatanGame {
  constructor({ numPlayers = 4, playerConfigs = [] } = {}) {
    this.id = crypto.randomUUID();
    this.numPlayers = numPlayers;
    this.board = generateBoard();
    this.playerAgents = this._buildPlayerAgents(numPlayers, playerConfigs);
    this.players = this._initPlayers(numPlayers, playerConfigs);
    this.current = 0;
    this.turn = 1;
    this.robberMovedThisTurn = false;
    this.lastRoll = null;
    this.lastProduction = null;
    this.devCardDeck = shuffle(DEV_CARD_DECK);
    this.log = [];
    
    // Add initial settlements and roads for each player
    this._placeInitialBuildings();
    this._recalculateVP();
  }

  // ----- internal helpers -----

  _buildPlayerAgents(numPlayers, playerConfigs = []) {
    return Array.from({ length: numPlayers }, (_, i) => {
      const config = playerConfigs[i] || {};
      if (config.type !== "llm") return null;

      const requestedModel = config.model || "gpt-4o";
      const normalizedModel =
        typeof requestedModel === "string" && requestedModel.toLowerCase().includes("gpt-4o")
          ? "gpt-4o"
          : requestedModel;
      const resolvedKey = resolveApiKey({
        ...config,
        provider: config.provider || "openai",
      });

      return {
        playerId: i,
        type: "llm",
        provider: config.provider || "openai",
        providerName: config.providerName || config.provider || "openai",
        providerCategory: config.providerCategory || null,
        model: normalizedModel,
        apiKey: config.apiKey || resolvedKey,
        apiEndpoint: config.apiEndpoint || null,
        algorithm: config.algorithm || "llm-only", // <--- ADD THIS
      };

    });
  }

  _initPlayers(numPlayers, playerConfigs = []) {
    const colors = ["#1976d2", "#e53935", "#8e24aa", "#ef6c00"];
    return Array.from({ length: numPlayers }, (_, i) => ({
      id: i,
      name: (() => {
        const cfg = playerConfigs[i] || {};
        const isAI = cfg.type === "llm";
        const aiLabel = cfg.providerName || cfg.provider;
        return cfg.name || (isAI && aiLabel ? aiLabel : `Player ${i + 1}`);
      })(),
      color: colors[i],
      model: (playerConfigs[i]?.type === "llm") ? "ai" : "human",
      type: playerConfigs[i]?.type || "human",
      provider: playerConfigs[i]?.type === "llm" ? (playerConfigs[i]?.provider || "openai") : null,
      providerName: playerConfigs[i]?.type === "llm" ? (playerConfigs[i]?.providerName || playerConfigs[i]?.provider || "AI") : null,
      providerModel: (() => {
        if (playerConfigs[i]?.type !== "llm") return null;
        const requestedModel = playerConfigs[i]?.model || "gpt-4o";
        return typeof requestedModel === "string" && requestedModel.toLowerCase().includes("gpt-4o")
          ? "gpt-4o"
          : requestedModel;
      })(),
      providerCategory: playerConfigs[i]?.providerCategory || null,
      algorithm: playerConfigs[i]?.algorithm || "llm-only",
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
    }));
  }

  _placeInitialBuildings() {
    const { nodes, edges, tiles } = this.board;
    
    // Find desert tile indices
    const desertTileIndices = tiles
      .map((tile, index) => tile.resource === "desert" ? index : -1)
      .filter(index => index !== -1);
    
    // Filter out nodes that are adjacent to desert tiles or not buildable
    const availableNodes = nodes.filter(n => {
      if (n.building) return false; // already occupied
      if (!n.canBuild) return false; // not adjacent to land
      
      // Check if this node is adjacent to any desert tile
      const isAdjacentToDesert = n.adjHexes.some(hexIdx => 
        desertTileIndices.includes(hexIdx)
      );
      
      return !isAdjacentToDesert; // only allow nodes NOT adjacent to desert
    });
    
    // For each player, place 2 towns and connect each with a road
    for (let playerId = 0; playerId < this.numPlayers; playerId++) {
      for (let settlement = 0; settlement < 2; settlement++) {
        if (availableNodes.length === 0) break;
        
        // Randomly select a node for the town
        const randomIndex = Math.floor(Math.random() * availableNodes.length);
        const selectedNode = availableNodes[randomIndex];
        
        // Place the town using the buildTown method (but free)
        const nodeId = selectedNode.id;
        selectedNode.building = { ownerId: playerId, type: "town" };
        
        // Remove this node from available nodes
        availableNodes.splice(randomIndex, 1);
        
        // Find edges connected to this node and place a road on a random one
        const connectedEdges = edges.filter(e => {
          if (e.ownerId !== null) return false; // edge already owned
          
          const isConnected = e.n1 === nodeId || e.n2 === nodeId;
          if (!isConnected) return false;
          
          // Check if both nodes connected by this edge are buildable
          const node1 = nodes.find(n => n.id === e.n1);
          const node2 = nodes.find(n => n.id === e.n2);
          
          return node1?.canBuild && node2?.canBuild;
        });
        
        if (connectedEdges.length > 0) {
          const randomEdgeIndex = Math.floor(Math.random() * connectedEdges.length);
          connectedEdges[randomEdgeIndex].ownerId = playerId;
        }
        
        // Remove nodes that are too close (adjacent) to maintain spacing
        const adjacentNodeIds = edges
          .filter(e => e.n1 === nodeId || e.n2 === nodeId)
          .flatMap(e => [e.n1, e.n2])
          .filter(id => id !== nodeId);
        
        // Remove adjacent nodes from available nodes to prevent close placement
        for (let i = availableNodes.length - 1; i >= 0; i--) {
          if (adjacentNodeIds.includes(availableNodes[i].id)) {
            availableNodes.splice(i, 1);
          }
        }
      }
    }
  }

  _emit(event) {
    const full = {
      timestamp: new Date().toISOString(),
      ...event,
    };
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
    const stats = this.players.map(() => ({
      towns: 0,
      cities: 0,
      roads: 0,
    }));

    this.board.nodes.forEach((node) => {
      if (node.building) {
        const owner = node.building.ownerId;
        if (owner == null || !stats[owner]) return;
        if (node.building.type === "town") stats[owner].towns += 1;
        if (node.building.type === "city") stats[owner].cities += 1;
      }
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
        if (node.building && node.adjHexes.includes(hexIdx)) {
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
            resources: Object.entries(resources).map(([resource, amount]) => ({
              resource,
              amount,
            })),
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

  // ----- Turn / dice / robber -----

  rollDice() {
    const currentPlayer = this.players[this.current];
    
    // Check if player already rolled
    if (currentPlayer.hasRolled) {
      throw new Error("You already rolled this turn!");
    }
    
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const total = d1 + d2;
    this.lastRoll = { d1, d2, total };
  
    // Mark that this player has rolled
    this.players = this.players.map((p) =>
      p.id === this.current ? { ...p, hasRolled: true } : p
    );
  
    if (total !== 7) {
      this._awardProduction(total);
    }
  
    const event = this._emit({ type: "rollDice", d1, d2, total });
    return event;
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

    if (!opts.free) {
      this._requireRoll(playerId);
    }

    const board = this.board;
    const edge = board.edges[edgeId];
    if (!edge) throw new Error("Invalid edge");
    if (edge.ownerId != null) throw new Error("Edge already taken");

    const node1 = board.nodes[edge.n1];
    const node2 = board.nodes[edge.n2];

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    // Must connect to player's building or existing road
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
      throw new Error("Road must connect to your building or existing road");
    }

    // At least one adjacent node must be buildable (not all water)
    if (!node1.canBuild && !node2.canBuild) {
      throw new Error("Cannot build road here - no adjacent land");
    }

    // Pay cost unless free (e.g. Road Building card)
    const cost = BUILDING_COSTS.road;
    if (!opts.free && !canAfford(player.resources, cost)) {
      throw new Error("Not enough resources for road");
    }

    const updatedPlayer = {
      ...player,
      resources: opts.free ? player.resources : deductResources(player.resources, cost),
    };

    const newEdges = board.edges.slice();
    newEdges[edgeId] = { ...edge, ownerId: playerId };

    let newPlayers = this.players.map((p) =>
      p.id === playerId ? updatedPlayer : p
    );

    // Update longest road and VP
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

    if (!node.canBuild) {
      throw new Error("Cannot build here - no adjacent land");
    }

    if (node.building) {
      throw new Error("Node already has a building");
    }

    // Distance rule: no adjacent building via edges
    const neighborNodeIds = board.edges
      .filter((e) => e.n1 === nodeId || e.n2 === nodeId)
      .flatMap((e) => [e.n1, e.n2])
      .filter((id) => id !== nodeId);

    const neighborOccupied = neighborNodeIds.some(
      (id) => board.nodes[id] && board.nodes[id].building
    );
    if (neighborOccupied) {
      throw new Error("Too close to another town/city");
    }

    if (!canAfford(player.resources, cost)) {
      throw new Error("Not enough resources for town");
    }

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
    if (!canAfford(player.resources, cost)) {
      throw new Error("Not enough resources for city");
    }

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

    const ratio = getBestTradingRatio(playerId, giveResource, this.board.nodes);
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
        ? { ...p, resources: newResources, trades: (p.trades || 0) + 1 }
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
    if (!this.devCardDeck.length) {
      throw new Error("No development cards left");
    }

    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    if (!canAfford(player.resources, DEV_CARD_COST)) {
      throw new Error("Not enough resources for dev card");
    }

    const cardType = this.devCardDeck.pop(); // draw from top
    const updatedPlayer = {
      ...player,
      resources: deductResources(player.resources, DEV_CARD_COST),
      devCards: [...player.devCards, { type: cardType, canPlay: false }],
      boughtDevCardThisTurn: true,
    };

    this.players = this.players.map((p) =>
      p.id === playerId ? updatedPlayer : p
    );
    this._recalculateVP(); // victory cards immediately count

    return this._emit({ type: "buyDevCard", playerId, cardType });
  }

  playKnight(playerId = this.current) {
    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const idx = player.devCards.findIndex(
      (c) => c.type === "knight" && c.canPlay
    );
    if (idx === -1) {
      throw new Error("No playable Knight card");
    }

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
    if (idx === -1) {
      throw new Error("No playable Year of Plenty card");
    }

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

    // Find a playable monopoly card
    const idx = player.devCards.findIndex(
      (c) => c.type === "monopoly" && c.canPlay
    );
    if (idx === -1) {
      throw new Error("No playable Monopoly card");
    }

    // First compute how much we will steal
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

    // Now update the playing player
    const updatedPlayer = intermediate.find((p) => p.id === playerId);
    const newDevCards = updatedPlayer.devCards.filter((_, i) => i !== idx);
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

  // Road Building: gives 2 free road builds; client will call buildRoad(..., {free:true}) twice
  playRoadBuilding(playerId = this.current) {
    const player = this.players[playerId];
    if (!player) throw new Error("Invalid player");

    const idx = player.devCards.findIndex(
      (c) => c.type === "road-building" && c.canPlay
    );
    if (idx === -1) {
      throw new Error("No playable Road Building card");
    }

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
    this.players = this.players.map((p) => ({
      ...p,
      devCards: p.devCards.map((card) => ({ ...card, canPlay: true })),
      boughtDevCardThisTurn: false,
      hasRolled: false, // ADD THIS LINE - reset for next player
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
