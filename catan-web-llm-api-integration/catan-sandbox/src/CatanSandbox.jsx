// src/CatanSandbox.jsx
import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import PropTypes from "prop-types";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowsLeftRight,
  CreditCard,
  ArrowCounterClockwise,
  Play,
  X,
  Check,
  WarningCircle,
  CaretLeft,
  CaretRight,
  ChartBar,
  GameController,
  Cube,
  Users,
} from "@phosphor-icons/react";

import { generateBoard, TILE_SIZE } from "../shared/board.js";
import { Button } from "./components/ui/Button.jsx";
import { GameBoard } from "./components/GameBoard.jsx";
import { PlayerDashboard } from "./components/PlayerDashboard.jsx";
import { StatsDashboard } from "./components/StatsDashboard.jsx";
import { SetupScreen } from "./components/SetupScreen.jsx";
import { cn, resourceEmoji } from "./lib/utils.js";

// ============================================
// Constants
// ============================================
const BOARD_PADDING = 30;
const DEFAULT_COLORS = ["#3b82f6", "#ef4444", "#a855f7", "#f97316"];

const DEV_CARD_DECK = [
  ...Array(14).fill({ type: "knight" }),
  ...Array(5).fill({ type: "victory" }),
  ...Array(2).fill({ type: "road-building" }),
  ...Array(2).fill({ type: "year-of-plenty" }),
  ...Array(2).fill({ type: "monopoly" }),
];

function randShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================
// Player Config (includes algorithmMode + algorithm)
// ============================================
const defaultPlayerConfig = () => ({
  type: "human",
  provider: null,
  providerCategory: null,
  providerName: "",
  model: null,

  // Backend-facing algorithm controls
  algorithmMode: "llm_only", // "llm_only" | "algo_only" | "llm_plus_algo" | "none"
  algorithm: "none", // "none" | "heuristic" | "mcts" etc.
  algorithmParams: {},

  apiKey: "",
  apiEndpoint: "",
  apiKeyStatus: "idle",
  apiKeyMessage: "",
});

function normalizeConfigs(count, configs) {
  const base = Array.isArray(configs) ? configs.slice(0, count) : [];
  const out = Array.from({ length: count }, (_, i) => base[i] ?? defaultPlayerConfig());

  return out.map((c) => ({
    ...defaultPlayerConfig(),
    ...c,
    algorithmMode: c?.algorithmMode || "llm_only",
    algorithm: c?.algorithm || "none",
    algorithmParams:
      c?.algorithmParams && typeof c.algorithmParams === "object"
        ? c.algorithmParams
        : {},
  }));
}

// ============================================
// Custom Hook: useBoard
// ============================================
function useBoard() {
  const [board, setBoard] = useState(() => generateBoard());
  const rerandomize = () => setBoard(generateBoard());

  const bbox = useMemo(() => {
    const tiles = board?.tiles || [];
    const centers = tiles.map((t) => t.center).filter(Boolean);
    if (centers.length === 0) {
      return { minX: 0, minY: 0, width: 1000, height: 800 };
    }

    const xs = centers.map((c) => c.x);
    const ys = centers.map((c) => c.y);
    const minX = Math.min(...xs) - TILE_SIZE - BOARD_PADDING;
    const maxX = Math.max(...xs) + TILE_SIZE + BOARD_PADDING;
    const minY = Math.min(...ys) - TILE_SIZE - BOARD_PADDING;
    const maxY = Math.max(...ys) + TILE_SIZE + BOARD_PADDING;

    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [board]);

  return { board, setBoard, rerandomize, bbox };
}

// ============================================
// Trade Panel Component
// ============================================
function TradePanel({ currentPlayer, onTrade, onClose, nodes }) {
  const [giveAmounts, setGiveAmounts] = useState({
    wood: 0,
    brick: 0,
    wheat: 0,
    sheep: 0,
    ore: 0,
  });
  const [receiveAmounts, setReceiveAmounts] = useState({
    wood: 0,
    brick: 0,
    wheat: 0,
    sheep: 0,
    ore: 0,
  });
  const resources = ["wood", "brick", "wheat", "sheep", "ore"];

  const getTradingRatios = () => {
    const ratios = { default: 4 };
    (nodes || []).forEach((node) => {
      if (node?.building && node.building.ownerId === currentPlayer.id) {
        (node.harbors || []).forEach((harbor) => {
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
  };

  const tradingRatios = getTradingRatios();
  const totalGive = Object.values(giveAmounts).reduce(
    (sum, val) => sum + val,
    0
  );
  const totalReceive = Object.values(receiveAmounts).reduce(
    (sum, val) => sum + val,
    0
  );
  const giveResource = Object.entries(giveAmounts).find(
    ([, amount]) => amount > 0
  )?.[0];
  const requiredRatio = giveResource
    ? tradingRatios[giveResource] || tradingRatios.default
    : 4;

  const canTrade =
    totalGive === requiredRatio &&
    totalReceive === 1 &&
    Object.entries(giveAmounts).every(
      ([resource, amount]) =>
        (currentPlayer.resources?.[resource] || 0) >= amount
    );

  const handleGiveChange = (resource, amount) => {
    const newAmounts = {
      wood: 0,
      brick: 0,
      wheat: 0,
      sheep: 0,
      ore: 0,
    };
    newAmounts[resource] = Math.max(0, amount);
    setGiveAmounts(newAmounts);
  };

  const handleReceiveChange = (resource, amount) => {
    setReceiveAmounts((prev) => ({
      ...prev,
      [resource]: Math.max(0, amount),
    }));
  };

  const executeTrade = () => {
    if (!canTrade) return;
    const giveRes = Object.entries(giveAmounts).find(
      ([, amount]) => amount > 0
    )?.[0];
    const receiveRes = Object.entries(receiveAmounts).find(
      ([, amount]) => amount > 0
    )?.[0];
    if (giveRes && receiveRes) {
      onTrade(giveRes, receiveRes);
      setGiveAmounts({
        wood: 0,
        brick: 0,
        wheat: 0,
        sheep: 0,
        ore: 0,
      });
      setReceiveAmounts({
        wood: 0,
        brick: 0,
        wheat: 0,
        sheep: 0,
        ore: 0,
      });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className="rounded-xl overflow-hidden shadow-2xl shadow-black/50"
    >
      <div className="bg-slate-900/95 backdrop-blur-xl">
        <div className="flex items-center justify-between p-3">
          <div className="flex items-center gap-2">
            <ArrowsLeftRight size={16} className="text-cyan-400" />
            <div>
              <h3 className="text-sm font-medium text-slate-200">
                Harbor Trading
              </h3>
              <p className="text-[10px] text-slate-600">
                {Object.keys(tradingRatios).length > 1 ? (
                  Object.entries(tradingRatios).map(([r, ratio]) => (
                    <span key={r} className="mr-2">
                      {r === "default"
                        ? `${ratio}:1`
                        : `${ratio}:1 ${r}`}
                    </span>
                  ))
                ) : (
                  "4:1 (no harbors)"
                )}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="iconSm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        <div className="p-3 grid md:grid-cols-2 gap-3">
          {/* Give side */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-400 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
              Give ({totalGive}/{requiredRatio})
            </div>

            {resources.map((resource) => {
              const available = currentPlayer.resources?.[resource] || 0;
              const resourceRatio =
                tradingRatios[resource] || tradingRatios.default;

              return (
                <div
                  key={resource}
                  className="flex items-center justify-between p-2 rounded-lg bg-black/25"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">
                      {resourceEmoji(resource)}
                    </span>
                    <span className="text-xs text-slate-400 capitalize">
                      {resource}
                    </span>
                    <span className="text-[10px] text-slate-600">
                      ({available})
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() =>
                        handleGiveChange(resource, giveAmounts[resource] - 1)
                      }
                      disabled={giveAmounts[resource] <= 0}
                    >
                      −
                    </Button>
                    <span className="w-5 text-center text-slate-300 font-medium text-sm font-mono">
                      {giveAmounts[resource]}
                    </span>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() =>
                        handleGiveChange(resource, giveAmounts[resource] + 1)
                      }
                      disabled={
                        giveAmounts[resource] >= available ||
                        totalGive >= resourceRatio
                      }
                    >
                      +
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Receive side */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Receive ({totalReceive}/1)
            </div>

            {resources.map((resource) => (
              <div
                key={resource}
                className="flex items-center justify-between p-2 rounded-lg bg-black/25"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">
                    {resourceEmoji(resource)}
                  </span>
                  <span className="text-xs text-slate-400 capitalize">
                    {resource}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() =>
                      handleReceiveChange(
                        resource,
                        receiveAmounts[resource] - 1
                      )
                    }
                    disabled={receiveAmounts[resource] <= 0}
                  >
                    −
                  </Button>
                  <span className="w-5 text-center text-slate-300 font-medium text-sm font-mono">
                    {receiveAmounts[resource]}
                  </span>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() =>
                      handleReceiveChange(
                        resource,
                        receiveAmounts[resource] + 1
                      )
                    }
                    disabled={
                      receiveAmounts[resource] >= 1 ||
                      totalReceive >= 1
                    }
                  >
                    +
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-3 flex items-center justify-between">
          <p className="text-xs text-slate-600">
            {!canTrade &&
              totalGive === requiredRatio &&
              totalReceive === 1 &&
              "Not enough resources"}
            {totalGive < requiredRatio &&
              `Select ${requiredRatio} to give`}
            {totalGive === requiredRatio &&
              totalReceive < 1 &&
              " Select 1 to receive"}
          </p>

          <Button
            variant={canTrade ? "success" : "secondary"}
            disabled={!canTrade}
            onClick={executeTrade}
            size="default"
          >
            <ArrowsLeftRight size={14} />
            Trade
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

TradePanel.propTypes = {
  currentPlayer: PropTypes.object.isRequired,
  onTrade: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  nodes: PropTypes.array.isRequired,
};

// ============================================
// Collapsible Sidebar Wrapper
// ============================================
function CollapsibleSidebar({
  collapsed,
  onToggle,
  side,
  children,
  icon: Icon,
  title,
}) {
  const isLeft = side === "left";

  const ToggleButton = () => (
    <button
      onClick={onToggle}
      className={cn(
        "flex-shrink-0 w-5 h-full flex items-center justify-center transition-all group/toggle",
        "hover:bg-indigo-600/20"
      )}
      title={collapsed ? "Expand" : "Collapse"}
    >
      <div
        className={cn(
          "w-5 h-16 flex items-center justify-center",
          "bg-gradient-to-b from-indigo-600/80 to-indigo-700/90",
          "hover:from-indigo-500/90 hover:to-indigo-600/95",
          "text-white/80 hover:text-white transition-all",
          "shadow-lg shadow-indigo-900/30",
          isLeft ? "rounded-r-lg" : "rounded-l-lg"
        )}
      >
        {isLeft ? (
          collapsed ? (
            <CaretRight size={14} weight="bold" />
          ) : (
            <CaretLeft size={14} weight="bold" />
          )
        ) : collapsed ? (
          <CaretLeft size={14} weight="bold" />
        ) : (
          <CaretRight size={14} weight="bold" />
        )}
      </div>
    </button>
  );

  return (
    <div className="h-full flex-shrink-0 flex items-stretch">
      {!isLeft && <ToggleButton />}

      <motion.aside
        animate={{ width: collapsed ? 48 : 280 }}
        transition={{ type: "spring", stiffness: 300, damping: 35 }}
        className="h-full"
      >
        {collapsed ? (
          <div className="h-full rounded-2xl bg-gradient-to-br from-slate-900/70 to-slate-950/80 backdrop-blur-lg flex flex-col items-center justify-center gap-2 shadow-2xl shadow-black/40">
            {Icon && <Icon size={16} className="text-slate-500" />}
            <span className="text-[10px] text-slate-600 [writing-mode:vertical-rl] rotate-180">
              {title}
            </span>
          </div>
        ) : (
          <div className="h-full relative rounded-2xl bg-gradient-to-br from-slate-900/70 to-slate-950/80 shadow-2xl shadow-black/40 overflow-hidden backdrop-blur-lg">
            {children}
            <div
              className={cn(
                "absolute top-4 bottom-4 w-px",
                isLeft ? "right-0" : "left-0"
              )}
              style={{
                background:
                  "linear-gradient(180deg, transparent, rgba(255,255,255,0.04) 20%, rgba(255,255,255,0.04) 80%, transparent)",
              }}
            />
          </div>
        )}
      </motion.aside>

      {isLeft && <ToggleButton />}
    </div>
  );
}

CollapsibleSidebar.propTypes = {
  collapsed: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
  side: PropTypes.oneOf(["left", "right"]).isRequired,
  children: PropTypes.node.isRequired,
  icon: PropTypes.elementType,
  title: PropTypes.string,
};

// ============================================
// Dev Card Panel
// ============================================
function DevCardPanel({ player, devCardDeck, onClose, onPlayCard }) {
  const cardInfo = {
    victory: { name: "Victory Point", emoji: "⭐" },
    knight: { name: "Knight", emoji: "⚔️" },
    "road-building": { name: "Road Building", emoji: "🛣️" },
    "year-of-plenty": { name: "Year of Plenty", emoji: "🌾" },
    monopoly: { name: "Monopoly", emoji: "💰" },
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 16 }}
        className="relative bg-slate-900/95 backdrop-blur-xl rounded-xl shadow-2xl max-w-lg w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-2">
            <CreditCard size={18} className="text-purple-400" />
            <span className="text-sm font-medium text-slate-200">
              Development Cards
            </span>
          </div>
          <Button variant="ghost" size="iconSm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        <div className="p-4">
          {player.devCards?.length === 0 ? (
            <div className="text-center py-8">
              <CreditCard
                size={24}
                className="mx-auto mb-2 text-slate-600"
              />
              <p className="text-slate-500 text-sm">No cards yet</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {(player.devCards || []).map((card, index) => {
                const info =
                  cardInfo[card.type] || {
                    name: card.type,
                    emoji: "🃏",
                  };
                return (
                  <motion.div
                    key={`${card.type}-${index}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.04 }}
                    className={cn(
                      "rounded-lg p-3 transition-all",
                      card.canPlay
                        ? "bg-slate-800/50 hover:bg-slate-700/50"
                        : "bg-slate-900/50 opacity-50"
                    )}
                  >
                    <div className="text-2xl text-center mb-1">
                      {info.emoji}
                    </div>
                    <div className="text-slate-300 font-medium text-center text-xs mb-2">
                      {info.name}
                    </div>

                    {card.type !== "victory" ? (
                      <Button
                        variant={
                          card.canPlay ? "primary" : "secondary"
                        }
                        size="xs"
                        className="w-full"
                        disabled={!card.canPlay}
                        onClick={() => onPlayCard(index)}
                      >
                        {card.canPlay ? "Play" : "Wait"}
                      </Button>
                    ) : (
                      <div className="text-center text-[10px] text-slate-600">
                        Auto
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-4 flex items-center justify-between text-xs text-slate-600">
          <span>
            Knights:{" "}
            <span className="text-slate-400">
              {player.knightsPlayed || 0}
            </span>
          </span>
          <span>
            Deck:{" "}
            <span className="text-slate-400">{devCardDeck.length}</span>
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

DevCardPanel.propTypes = {
  player: PropTypes.object.isRequired,
  devCardDeck: PropTypes.array.isRequired,
  onClose: PropTypes.func.isRequired,
  onPlayCard: PropTypes.func.isRequired,
};

// ============================================
// Winner Modal
// ============================================
function WinnerModal({ winner, onNewGame }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50"
    >
      <motion.div
        initial={{ scale: 0.8, y: 40 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: "spring", bounce: 0.4 }}
        className="bg-slate-900/95 backdrop-blur-xl rounded-2xl p-8 text-center shadow-2xl"
      >
        <div className="text-6xl mb-4">🏆</div>
        <h2 className="text-2xl font-bold text-slate-200 mb-2">
          Victory!
        </h2>
        <p className="text-base mb-6">
          <span
            style={{ color: winner.color }}
            className="font-bold"
          >
            {winner.name}
          </span>
          <span className="text-slate-400"> wins with </span>
          <span className="text-amber-400 font-bold">
            {winner.vp ?? winner.victoryPoints ?? 0} VP
          </span>
        </p>
        <Button variant="warning" size="lg" onClick={onNewGame}>
          <Play size={16} weight="fill" />
          New Game
        </Button>
      </motion.div>
    </motion.div>
  );
}

WinnerModal.propTypes = {
  winner: PropTypes.object.isRequired,
  onNewGame: PropTypes.func.isRequired,
};

// ============================================
// Toast Notification
// ============================================
function Toast({ message, type }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={cn(
        "fixed top-4 left-1/2 -translate-x-1/2 z-50",
        "px-4 py-2 rounded-lg shadow-xl backdrop-blur-xl",
        "flex items-center gap-2",
        type === "success" && "bg-emerald-500/90 text-white",
        type === "error" && "bg-red-500/90 text-white",
        type === "info" && "bg-slate-800/95 text-slate-50"
      )}
    >
      {type === "success" ? (
        <Check size={16} weight="bold" />
      ) : type === "error" ? (
        <WarningCircle size={16} />
      ) : (
        <GameController size={16} />
      )}
      <span className="font-medium text-sm">{message}</span>
    </motion.div>
  );
}

Toast.propTypes = {
  message: PropTypes.string.isRequired,
  type: PropTypes.string.isRequired,
};

// ============================================
// Control Dock
// ============================================
function ControlDock({
  onReroll,
  onEndTurn,
  onNewGame,
  onReset,
  onAutoPlay,
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute left-1/2 -translate-x-1/2 bottom-4 z-50"
    >
      <div className="flex items-center gap-1 rounded-xl bg-slate-900/80 backdrop-blur-xl px-2 py-1.5 shadow-xl shadow-black/40">
        <Button variant="warning" size="default" onClick={onReroll}>
          <Cube size={14} />
          Roll
        </Button>

        <div className="w-px h-4 bg-slate-700/40 mx-0.5" />

        <Button variant="success" size="default" onClick={onEndTurn}>
          <Check size={14} weight="bold" />
          End
        </Button>

        <div className="w-px h-4 bg-slate-700/40 mx-0.5" />

        <Button variant="ghost" size="default" onClick={onNewGame}>
          <Play size={14} weight="fill" />
          New
        </Button>

        <Button variant="primary" size="default" onClick={onAutoPlay}>
          <Play size={14} />
          Auto
        </Button>

        <Button variant="ghost" size="icon" onClick={onReset}>
          <ArrowCounterClockwise size={14} />
        </Button>
      </div>
    </motion.div>
  );
}

ControlDock.propTypes = {
  onReroll: PropTypes.func.isRequired,
  onEndTurn: PropTypes.func.isRequired,
  onNewGame: PropTypes.func.isRequired,
  onReset: PropTypes.func.isRequired,
  onAutoPlay: PropTypes.func.isRequired,
};

// ============================================
// Main Component
// ============================================
export default function CatanSandbox() {
  const { board, setBoard, rerandomize, bbox } = useBoard();

  const [stage, setStage] = useState("setup");
  const [numPlayers, _setNumPlayers] = useState(4);

  const [playerConfigs, _setPlayerConfigs] = useState(() =>
    normalizeConfigs(4, Array.from({ length: 4 }, () => defaultPlayerConfig()))
  );

  const setNumPlayers = useCallback((count) => {
    _setNumPlayers(count);
    _setPlayerConfigs((prev) => normalizeConfigs(count, prev));
  }, []);

  const setPlayerConfigs = useCallback(
    (updater) => {
      _setPlayerConfigs((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        return normalizeConfigs(numPlayers, next);
      });
    },
    [numPlayers]
  );

  const [players, setPlayers] = useState([]);
  const [current, setCurrent] = useState(0);
  const [mode, setMode] = useState("select");

  const [lastRoll, setLastRoll] = useState(null);
  const [selection, setSelection] = useState(null);

  const [lastAction, setLastAction] = useState(null);
  const [lastProduction, setLastProduction] = useState(null);

  const [actionLog, setActionLog] = useState([]);
  const [turn, setTurn] = useState(1);

  const [devCardDeck, setDevCardDeck] = useState([]);
  const [showDevCardPanel, setShowDevCardPanel] = useState(false);

  const [winner, setWinner] = useState(null);
  const [gameId, setGameId] = useState(null);

  const [isLeftCollapsed, setLeftCollapsed] = useState(false);
  const [isRightCollapsed, setRightCollapsed] = useState(false);

  const aiTurnLock = useRef(false);

  const API_BASE =
    (typeof import.meta !== "undefined" &&
      import.meta.env?.VITE_API_BASE) ||
    "http://localhost:4000";

  const pushLog = useCallback((entry) => {
    setActionLog((prev) => {
      const next = [
        ...prev,
        {
          ...entry,
          id: entry.id || `${Date.now()}-${prev.length}`,
        },
      ];
      return next.slice(-80);
    });
  }, []);

  const applyStateFromServer = useCallback(
    (state) => {
      if (!state) return;
      if (state.board) setBoard(state.board);
      if (state.players) setPlayers(state.players);
      if (typeof state.current === "number") setCurrent(state.current);
      setLastRoll(state.lastRoll || null);
      setLastProduction(state.lastProduction || null);
      setWinner(state.winner || null);
      setTurn(state.turn || 1);
    },
    [setBoard]
  );

  const isAIPlayer = useCallback((player) => {
    if (!player) return false;
    return (
      player.type === "llm" ||
      player.model === "ai" ||
      !!player.provider
    );
  }, []);

  // ----- Local game helpers -----
  const placeInitialBuildings = useCallback(
    (newBoard) => {
      try {
        const { nodes = [], edges = [], tiles = [] } = newBoard || {};
        if (!nodes.length || !edges.length || !tiles.length) return newBoard;

        const desertTileIndices = tiles
          .map((tile, index) =>
            tile?.resource === "desert" ? index : -1
          )
          .filter((index) => index !== -1);

        const availableNodes = nodes.filter((n) => {
          if (!n || n.building || !n.canBuild) return false;
          const adj = Array.isArray(n.adjHexes) ? n.adjHexes : [];
          return !adj.some((hexIdx) =>
            desertTileIndices.includes(hexIdx)
          );
        });

        for (let playerId = 0; playerId < numPlayers; playerId++) {
          for (let settlement = 0; settlement < 2; settlement++) {
            if (availableNodes.length === 0) break;

            const randomIndex = Math.floor(
              Math.random() * availableNodes.length
            );
            const selectedNode = availableNodes[randomIndex];
            if (!selectedNode) continue;

            selectedNode.building = {
              ownerId: playerId,
              type: "town",
            };
            availableNodes.splice(randomIndex, 1);

            const connectedEdges = edges.filter((e) => {
              if (!e) return false;
              if (
                e.ownerId !== null &&
                e.ownerId !== undefined
              )
                return false;
              const isConnected =
                e.n1 === selectedNode.id || e.n2 === selectedNode.id;
              if (!isConnected) return false;

              const node1 = nodes.find((n) => n.id === e.n1);
              const node2 = nodes.find((n) => n.id === e.n2);
              return node1?.canBuild && node2?.canBuild;
            });

            if (connectedEdges.length > 0) {
              const randomEdgeIndex = Math.floor(
                Math.random() * connectedEdges.length
              );
              connectedEdges[randomEdgeIndex].ownerId = playerId;
            }

            const adjacentNodeIds = edges
              .filter(
                (e) =>
                  e.n1 === selectedNode.id ||
                  e.n2 === selectedNode.id
              )
              .flatMap((e) => [e.n1, e.n2])
              .filter((id) => id !== selectedNode.id);

            for (let i = availableNodes.length - 1; i >= 0; i--) {
              if (adjacentNodeIds.includes(availableNodes[i].id)) {
                availableNodes.splice(i, 1);
              }
            }
          }
        }

        return newBoard;
      } catch (e) {
        console.warn("placeInitialBuildings failed, continuing:", e);
        return newBoard;
      }
    },
    [numPlayers]
  );

  const startLocalGame = useCallback(() => {
    const ppl = Array.from({ length: numPlayers }, (_, i) => {
      const config = playerConfigs[i] || defaultPlayerConfig();
      const isLLM = config.type === "llm";

      return {
        id: i,
        name:
          isLLM && config.providerName
            ? `${config.providerName}`
            : `Player ${i + 1}`,
        color: DEFAULT_COLORS[i] || "#3b82f6",
        model: isLLM ? "ai" : "human",
        type: config.type,

        provider: config.provider,
        providerCategory: config.providerCategory,
        providerName: config.providerName,
        providerModel: config.model,

        // keep these in local state too
        algorithmMode: config.algorithmMode || "llm_only",
        algorithm: config.algorithm || "none",

        resources: {
          wood: 0,
          brick: 0,
          wheat: 0,
          sheep: 0,
          ore: 0,
        },
        vp: 0,
        victoryPoints: 0,
        devCards: [],
        knightsPlayed: 0,
      };
    });

    setDevCardDeck(randShuffle([...DEV_CARD_DECK]));
    const b = placeInitialBuildings(generateBoard());
    setBoard(b);
    setPlayers(ppl);

    setCurrent(0);
    setTurn(1);
    setActionLog([]);
    setMode("select");

    setLastRoll(null);
    setSelection(null);
    setLastProduction(null);

    setWinner(null);
    setGameId(null);
    setStage("play");
  }, [numPlayers, playerConfigs, placeInitialBuildings, setBoard]);

  const newGame = useCallback(() => {
    setStage("setup");
    setPlayers([]);
    setCurrent(0);
    setTurn(1);
    setActionLog([]);
    setMode("select");
    setLastRoll(null);
    setSelection(null);
    setLastProduction(null);
    setWinner(null);
    setGameId(null);

    setBoard(generateBoard());

    _setNumPlayers(4);
    _setPlayerConfigs(
      normalizeConfigs(
        4,
        Array.from({ length: 4 }, () => defaultPlayerConfig())
      )
    );
  }, [setBoard]);

  // ----- API start (with fallback) -----
  const startGameFromSetup = useCallback(async () => {
    try {
      const normalized = normalizeConfigs(
        numPlayers,
        playerConfigs
      ).slice(0, numPlayers);

      // Patch: Player 0 = heuristic algorithm-only, Player 1 = llm-only
      const patched = normalized.map((c, i) => {
        if (i === 0) {
          return {
            ...c,
            type: "llm",
            algorithmMode: "algo_only",
            algorithm: "heuristic", // change to "mcts" only if implemented
          };
        }
        if (i === 1) {
          return {
            ...c,
            type: "llm",
            algorithmMode: "llm_only",
          };
        }
        return c;
      });

      const res = await fetch(`${API_BASE}/api/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numPlayers, playerConfigs: patched }),
      });

      if (!res.ok) {
        throw new Error(
          `API ${res.status} ${res.statusText}`
        );
      }

      const data = await res.json();
      const state = data?.state ?? data;

      if (!state?.board || !state?.players) {
        throw new Error(
          "API returned invalid game state (missing board/players)"
        );
      }

      setGameId(state.id ?? data.id ?? null);
      applyStateFromServer(state);
      setStage("play");
      setActionLog([]);
      return;
    } catch (err) {
      console.error(
        "Failed to create game via API, falling back to local:",
        err
      );
    }

    try {
      startLocalGame();
    } catch (err) {
      console.error("Local start failed:", err);
      setLastAction({
        type: "error",
        message: "Could not start game (API + local failed)",
        timestamp: Date.now(),
      });
      setTimeout(() => setLastAction(null), 3000);
    }
  }, [
    API_BASE,
    numPlayers,
    playerConfigs,
    applyStateFromServer,
    startLocalGame,
  ]);

  // ----- API actions -----
  const sendAction = useCallback(
    async (action, payload = {}) => {
      if (!gameId) return;

      const actorId = payload.playerId ?? current;

      try {
        const res = await fetch(
          `${API_BASE}/api/games/${gameId}/actions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // { action, payload } matches backend
            body: JSON.stringify({ action, payload }),
          }
        );

        const data = await res.json();

        if (!res.ok || data.ok === false) {
          setLastAction({
            type: "error",
            message: data.error || "Action failed",
            timestamp: Date.now(),
          });
          setTimeout(() => setLastAction(null), 3000);
          return;
        }

        const state = data.state ?? data;
        applyStateFromServer(state);

        if (state.winner) {
          setLastAction({
            type: "success",
            message: `${state.winner.name} wins!`,
            timestamp: Date.now(),
          });
        }

        if (data.event?.type) {
          const actorPlayer = (state.players || players).find(
            (p) => p.id === actorId
          );
          const actorName =
            actorPlayer?.name || `Player ${actorId + 1}`;
          pushLog({
            timestamp: Date.now(),
            playerId: actorId,
            playerName: actorName,
            provider: actorPlayer?.provider,
            providerName:
              actorPlayer?.providerName || actorPlayer?.provider,
            providerModel: actorPlayer?.providerModel,
            message: `${data.event.type}`,
            turn: state.turn || turn,
          });
        }
      } catch (err) {
        console.error("sendAction error:", err);
        setLastAction({
          type: "error",
          message: "Network error",
          timestamp: Date.now(),
        });
        setTimeout(() => setLastAction(null), 3000);
      }
    },
    [API_BASE, gameId, current, applyStateFromServer, players, pushLog, turn]
  );

  const handleAutoPlay = useCallback(async () => {
    if (!gameId) return;

    try {
      const res = await fetch(
        `${API_BASE}/api/games/${gameId}/auto-play`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxSteps: 100 }),
        }
      );

      const data = await res.json();

      if (!res.ok || data.ok === false) {
        setLastAction({
          type: "error",
          message: data.error || "Auto-play failed",
          timestamp: Date.now(),
        });
        setTimeout(() => setLastAction(null), 3000);
        return;
      }

      const state = data.state ?? data;
      applyStateFromServer(state);

      if (state?.winner) {
        setWinner(state.winner);
        setLastAction({
          type: "success",
          message: `${state.winner.name} wins!`,
          timestamp: Date.now(),
        });
        setTimeout(() => setLastAction(null), 3000);
      }
    } catch (err) {
      console.error("Auto-play error:", err);
      setLastAction({
        type: "error",
        message: "Auto-play network error",
        timestamp: Date.now(),
      });
      setTimeout(() => setLastAction(null), 3000);
    }
  }, [API_BASE, gameId, applyStateFromServer]);

  // Single AI turn (LLM or algorithm), auto-applied
  const runAiTurn = useCallback(async () => {
    if (!gameId || stage !== "play") return;

    const currentPlayer = players[current];
    if (!isAIPlayer(currentPlayer)) return;
    if (aiTurnLock.current) return;

    aiTurnLock.current = true;
    const activePlayerId = currentPlayer?.id;

    const requestedModel = currentPlayer?.providerModel || "gpt-4o";
    const model =
      typeof requestedModel === "string" &&
      requestedModel.toLowerCase().includes("gpt-4o")
        ? "gpt-4o"
        : requestedModel;

    try {
      const res = await fetch(
        `${API_BASE}/api/games/${gameId}/llm-turn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoApply: true, model }),
        }
      );

      const data = await res.json();

      if (!res.ok || data.ok === false) {
        setLastAction({
          type: "error",
          message: data.error || "AI turn failed",
          timestamp: Date.now(),
        });
        setTimeout(() => setLastAction(null), 3000);
        return;
      }

      const state = data.state ?? data;
      applyStateFromServer(state);

      const actions = Array.isArray(data.actions)
        ? data.actions
        : [];
      const last = actions[actions.length - 1];

      if (last?.reason) {
        setLastAction({
          type: "info",
          message: `${
            currentPlayer?.name || "AI"
          }: ${last.action} – ${last.reason}`,
          timestamp: Date.now(),
        });
        setTimeout(() => setLastAction(null), 2500);
      }

      // log each action from the backend
      for (const a of actions) {
        pushLog({
          timestamp: Date.now(),
          playerId: activePlayerId,
          playerName: currentPlayer?.name || "AI Player",
          provider: currentPlayer?.provider,
          providerName:
            currentPlayer?.providerName || currentPlayer?.provider,
          providerModel: currentPlayer?.providerModel,
          message: `${a?.action || "action"}${
            a?.reason ? ` – ${a.reason}` : ""
          }`,
          turn: state?.turn || turn,
        });
      }
    } catch (err) {
      console.error("runAiTurn error:", err);
      setLastAction({
        type: "error",
        message: "AI turn failed",
        timestamp: Date.now(),
      });
      setTimeout(() => setLastAction(null), 3000);
    } finally {
      aiTurnLock.current = false;
    }
  }, [
    API_BASE,
    gameId,
    stage,
    players,
    current,
    isAIPlayer,
    applyStateFromServer,
    pushLog,
    turn,
  ]);

  // Auto-run AI whenever it becomes an AI player's turn
  useEffect(() => {
    if (!gameId || stage !== "play") return;
    const currentPlayer = players[current];
    if (!isAIPlayer(currentPlayer)) return;
    runAiTurn();
  }, [gameId, stage, current, players, isAIPlayer, runAiTurn]);

  // ----- Local + API gameplay wiring -----
  const endTurn = useCallback(() => {
    if (gameId) {
      sendAction("endTurn");
    } else {
      setCurrent((prev) =>
        players.length ? (prev + 1) % players.length : 0
      );
      setTurn((prev) => prev + 1);
    }
    setMode("select");
    setSelection(null);
    setLastProduction(null);
  }, [gameId, sendAction, players.length]);

  const onRollDice = useCallback(() => {
    if (gameId) {
      sendAction("rollDice");
    } else {
      const die1 = Math.floor(Math.random() * 6) + 1;
      const die2 = Math.floor(Math.random() * 6) + 1;
      setLastRoll({ die1, die2, total: die1 + die2 });
    }
  }, [gameId, sendAction]);

  const onClickHex = useCallback(
    (hexId) => {
      if (mode === "move-robber" && gameId) {
        sendAction("moveRobber", { hexId });
        setMode("select");
        setSelection(null);
        return;
      }
      setSelection({ type: "hex", id: hexId });
    },
    [mode, gameId, sendAction]
  );

  const onClickNode = useCallback(
    (nodeId) => {
      if (gameId) {
        if (mode === "build-town") {
          return sendAction("buildTown", { nodeId, playerId: current });
        }
        if (mode === "build-city") {
          return sendAction("buildCity", { nodeId, playerId: current });
        }
      }
      setSelection({ type: "node", id: nodeId });
    },
    [mode, gameId, sendAction, current]
  );

  const onClickEdge = useCallback(
    (edgeId) => {
      if (gameId && mode === "build-road") {
        return sendAction("buildRoad", { edgeId, playerId: current });
      }
      setSelection({ type: "edge", id: edgeId });
    },
    [mode, gameId, sendAction, current]
  );

  const executeTrade = useCallback(
    (giveResource, receiveResource) => {
      if (gameId) {
        sendAction("harborTrade", {
          playerId: current,
          giveResource,
          receiveResource,
        });
      } else {
        setLastAction({
          type: "info",
          message:
            "Local trade not wired (API mode recommended).",
          timestamp: Date.now(),
        });
        setTimeout(() => setLastAction(null), 2500);
      }
    },
    [gameId, sendAction, current]
  );

  const buyDevCard = useCallback(() => {
    if (gameId) {
      sendAction("buyDevCard");
    } else {
      setLastAction({
        type: "info",
        message:
          "Local dev cards not wired (API mode recommended).",
        timestamp: Date.now(),
      });
      setTimeout(() => setLastAction(null), 2500);
    }
  }, [gameId, sendAction]);

  const playDevCard = useCallback(() => {
    setLastAction({
      type: "info",
      message: "Dev card play not wired in this build.",
      timestamp: Date.now(),
    });
    setTimeout(() => setLastAction(null), 2500);
  }, []);

  // ============================================
  // Render
  // ============================================
  if (stage === "setup") {
    return (
      <SetupScreen
        numPlayers={numPlayers}
        setNumPlayers={setNumPlayers}
        playerConfigs={playerConfigs}
        setPlayerConfigs={setPlayerConfigs}
        onStart={startGameFromSetup}
        onRerandomize={rerandomize}
        board={board}
        bbox={bbox}
      />
    );
  }

  return (
    <div className="h-screen relative overflow-hidden">
      <AnimatePresence>
        {lastAction && (
          <Toast message={lastAction.message} type={lastAction.type} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {winner && (
          <WinnerModal winner={winner} onNewGame={newGame} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDevCardPanel && players[current] && (
          <DevCardPanel
            player={players[current]}
            devCardDeck={devCardDeck}
            onClose={() => setShowDevCardPanel(false)}
            onPlayCard={playDevCard}
          />
        )}
      </AnimatePresence>

      <div className="relative z-10 flex h-full gap-2 p-2">
        {/* Left sidebar: stats */}
        <CollapsibleSidebar
          collapsed={isLeftCollapsed}
          onToggle={() => setLeftCollapsed((v) => !v)}
          side="left"
          icon={ChartBar}
          title="Stats"
        >
          <div className="h-full overflow-hidden">
            <StatsDashboard
              players={players}
              board={board}
              gameStats={{ turn, lastRoll, lastProduction }}
            />
          </div>
        </CollapsibleSidebar>

        {/* Center: board */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <motion.header
            initial={{ y: -16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex-shrink-0 mb-2"
          >
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-slate-900/60 backdrop-blur-lg">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/20">
                  <span className="text-xs font-bold text-slate-900">
                    C
                  </span>
                </div>
                <span className="text-sm font-medium text-slate-300">
                  Settlers of Catan – Sandbox
                </span>
              </div>

              <div className="flex items-center gap-2">
                {lastRoll && (
                  <span className="px-2 py-1 rounded bg-slate-800/50 text-xs text-slate-400 font-mono">
                    Roll: {lastRoll.total}
                  </span>
                )}
              </div>
            </div>
          </motion.header>

          <div className="flex-1 overflow-hidden min-h-0">
            <motion.div
              key="game"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15 }}
              className="relative h-full"
            >
              <AnimatePresence>
                {mode === "trade" && players[current] && (
                  <div className="absolute top-2 left-2 right-2 z-10">
                    <TradePanel
                      currentPlayer={players[current]}
                      nodes={board?.nodes || []}
                      onTrade={executeTrade}
                      onClose={() => setMode("select")}
                    />
                  </div>
                )}
              </AnimatePresence>

              <GameBoard
                board={board}
                players={players}
                mode={mode}
                selection={selection}
                onClickHex={onClickHex}
                onClickNode={onClickNode}
                onClickEdge={onClickEdge}
                bbox={bbox}
              />

              <ControlDock
                onReroll={onRollDice}
                onEndTurn={endTurn}
                onNewGame={newGame}
                onReset={rerandomize}
                onAutoPlay={handleAutoPlay}
              />
            </motion.div>
          </div>
        </div>

        {/* Right sidebar: player overview */}
        <CollapsibleSidebar
          collapsed={isRightCollapsed}
          onToggle={() => setRightCollapsed((v) => !v)}
          side="right"
          icon={Users}
          title="Overview"
        >
          <PlayerDashboard
            players={players}
            currentPlayer={current}
            currentTurnIndex={current}
            lastRoll={lastRoll}
            lastProduction={lastProduction}
            actionLog={actionLog}
            onRollDice={onRollDice}
            onSelectPlayer={(player) => setCurrent(player.id)}
            onEndTurn={endTurn}
            onQuit={newGame}
            mode={mode}
            onSetMode={setMode}
            onBuyDevCard={buyDevCard}
            onShowDevCards={() => setShowDevCardPanel(true)}
          />
        </CollapsibleSidebar>
      </div>
    </div>
  );
}
