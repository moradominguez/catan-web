import React, { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Shuffle,
  Users,
  Robot,
  User,
  CaretDown,
  Check,
  Hexagon,
  Gear,
  CaretRight,
  Desktop,
  Sparkle,
  GameController,
  Key,
  WarningCircle,
  Brain,
} from "@phosphor-icons/react";

import { cn, resourceColor } from "../lib/utils";
import { getPlayerColor } from "../lib/colors";
import { TILE_SIZE, hexCorner } from "../../shared/board.js";
import {
  PROVIDER_ICONS,
  PROVIDER_COLORS,
  LLM_CATEGORIES,
  WHITE_LOGO_PROVIDERS,
} from "../lib/providers";

// ✅ Algorithms list
import { ALGORITHMS } from "../lib/algorithms";

const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE) ||
  "http://localhost:4000";

// ============================================
// Provider Logo with Real Icons
// ============================================
export function ProviderLogo({ providerId, size = 20 }) {
  const IconComponent = PROVIDER_ICONS[providerId];
  const color = PROVIDER_COLORS[providerId] || "#666";
  const useWhiteLogo = WHITE_LOGO_PROVIDERS.includes(providerId);

  if (IconComponent) {
    return (
      <div className="flex-shrink-0 flex items-center justify-center">
        {!useWhiteLogo && IconComponent.Color ? (
          <IconComponent.Color size={size} />
        ) : (
          <IconComponent size={size} style={{ color: useWhiteLogo ? "#ffffff" : color }} />
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md flex items-center justify-center font-bold text-white text-[9px] flex-shrink-0"
      style={{ width: size, height: size, background: color }}
    >
      {providerId?.slice(0, 2).toUpperCase() || "??"}
    </div>
  );
}
ProviderLogo.propTypes = { providerId: PropTypes.string, size: PropTypes.number };

// Helpers for looking up provider metadata
function findProvider(categoryId, providerId) {
  const category = LLM_CATEGORIES[categoryId];
  if (!category) return null;
  return category.providers.find((p) => p.id === providerId) || null;
}
function providerRequiresApiKey(categoryId, providerId) {
  const provider = findProvider(categoryId, providerId);
  if (!provider) return false;
  if (provider.local) return false;
  return true;
}
function getApiKeyValidation(categoryId, providerId, apiKey) {
  const required = providerRequiresApiKey(categoryId, providerId);
  const trimmed = (apiKey || "").trim();

  if (!required) return { required: false, isValid: true, message: "" };
  if (!trimmed) return { required: true, isValid: false, message: "API key required for this provider." };
  if (trimmed.length < 10) return { required, isValid: false, message: "API key looks too short." };
  return { required, isValid: true, message: "API key format looks okay." };
}

// ============================================
// LLM Provider Dropdown
// ============================================
function LLMProviderDropdown({ config, onChange, onClose }) {
  const defaultCategory = config.providerCategory || Object.keys(LLM_CATEGORIES)[0] || null;
  const [selectedCategory, setSelectedCategory] = useState(defaultCategory);
  const [expandedProvider, setExpandedProvider] = useState(
    config.provider
      ? { categoryId: config.providerCategory || defaultCategory, providerId: config.provider }
      : null
  );

  const updateProviderState = (categoryId, provider, extra = {}) => {
    const fallbackModel = provider.models?.[0] || "";
    const fallbackEndpoint = provider.endpoints?.[0]?.url || "";
    const sameProvider = config.provider === provider.id;

    const resolvedModel =
      extra.model ?? (sameProvider ? config.model : null) ?? fallbackModel;
    const resolvedEndpoint =
      extra.apiEndpoint ?? (sameProvider ? config.apiEndpoint : null) ?? fallbackEndpoint;

    onChange({
      ...config,
      providerCategory: categoryId,
      provider: provider.id,
      providerName: provider.name,
      model: resolvedModel,
      apiEndpoint: resolvedEndpoint,
      apiKey: config.apiKey || "",
      apiKeyStatus: sameProvider ? config.apiKeyStatus || "idle" : "idle",
      apiKeyMessage: sameProvider ? config.apiKeyMessage || "" : "",
    });
  };

  const handleProviderSelect = (categoryId, provider) => {
    setExpandedProvider((prev) =>
      prev?.providerId === provider.id && prev?.categoryId === categoryId
        ? null
        : { categoryId, providerId: provider.id }
    );
    updateProviderState(categoryId, provider);
  };

  const handleModelSelect = (categoryId, provider, model) => {
    updateProviderState(categoryId, provider, { model });
    onClose();
  };

  const handleEndpointSelect = (categoryId, provider, endpointUrl) => {
    updateProviderState(categoryId, provider, { apiEndpoint: endpointUrl });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="mt-3 w-full z-[40] rounded-2xl bg-slate-950/95 backdrop-blur-md shadow-2xl shadow-black/70 overflow-hidden ring-1 ring-white/5"
    >
      <div className="max-h-[440px] overflow-y-auto">
        {Object.entries(LLM_CATEGORIES).map(([categoryId, category]) => (
          <div key={categoryId}>
            <button
              onClick={() => setSelectedCategory(selectedCategory === categoryId ? null : categoryId)}
              className="w-full flex items-center justify-between px-5 py-3.5 bg-slate-900/60 hover:bg-slate-800/60 transition-colors rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
            >
              <div className="flex items-center gap-3">
                <div className="w-2 h-8 rounded-full" style={{ background: `${category.color}40` }} />
                <span className="text-sm font-semibold text-slate-100 tracking-tight">
                  {`${category.label} (${category.providers.length})`}
                </span>
              </div>
              <CaretRight
                size={16}
                weight="bold"
                className={cn(
                  "text-slate-500 transition-transform duration-200",
                  selectedCategory === categoryId && "rotate-90 text-slate-300"
                )}
              />
            </button>

            <AnimatePresence>
              {selectedCategory === categoryId && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden bg-slate-950/60 rounded-xl mt-1"
                >
                  {category.providers.map((provider) => (
                    <div key={provider.id} className="px-3 pb-1">
                      <button
                        onClick={() => handleProviderSelect(categoryId, provider)}
                        className={cn(
                          "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-150 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] hover:shadow-[0_0_0_1px_rgba(129,140,248,0.4)] hover:bg-slate-900/70",
                          config.provider === provider.id &&
                            "bg-slate-900/80 shadow-[0_0_0_1px_rgba(129,140,248,0.45)]"
                        )}
                      >
                        <ProviderLogo providerId={provider.id} size={20} />
                        <span className="text-sm text-slate-200 flex-1 text-left font-medium">
                          {provider.name}
                        </span>
                        {provider.local && (
                          <span className="text-[11px] text-slate-500 bg-slate-800/70 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                            <Desktop size={12} />
                            Local
                          </span>
                        )}
                        <CaretDown
                          size={14}
                          weight="bold"
                          className={cn(
                            "text-slate-500 transition-transform",
                            expandedProvider?.providerId === provider.id &&
                              expandedProvider?.categoryId === categoryId &&
                              "rotate-180 text-slate-200"
                          )}
                        />
                        {config.provider === provider.id && (
                          <Check size={16} weight="bold" className="text-indigo-400" />
                        )}
                      </button>

                      <AnimatePresence>
                        {expandedProvider?.providerId === provider.id &&
                          expandedProvider?.categoryId === categoryId &&
                          provider.models?.length > 0 && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.18 }}
                              className="overflow-hidden pt-2 space-y-2"
                            >
                              {provider.models.map((model, idx) => {
                                const endpoints = provider.endpoints || [];
                                const selectedEndpoint =
                                  (config.provider === provider.id && config.apiEndpoint) ||
                                  endpoints[0]?.url ||
                                  "";
                                const isModelSelected =
                                  config.provider === provider.id && config.model === model;
                                const rowTone = idx % 2 === 0 ? "bg-slate-900/60" : "bg-slate-800/60";

                                return (
                                  <button
                                    key={model}
                                    onClick={() => handleModelSelect(categoryId, provider, model)}
                                    className={cn(
                                      "w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl transition-colors",
                                      rowTone,
                                      "hover:bg-slate-800/80 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]",
                                      isModelSelected &&
                                        "shadow-[0_0_0_1px_rgba(129,140,248,0.45)] ring-1 ring-indigo-400/60"
                                    )}
                                  >
                                    <div className="w-1 h-full rounded-full bg-gradient-to-b from-indigo-400/60 to-purple-400/60" />
                                    <ProviderLogo providerId={provider.id} size={18} />
                                    <div className="flex-1">
                                      <div className="text-sm font-semibold text-slate-200">{model}</div>
                                      {endpoints.length > 0 && (
                                        <div className="text-[11px] text-slate-500">
                                          {endpoints.find((e) => e.url === selectedEndpoint)?.label || "Default endpoint"}
                                        </div>
                                      )}
                                    </div>
                                    {isModelSelected && (
                                      <Check size={16} weight="bold" className="text-indigo-300" />
                                    )}
                                  </button>
                                );
                              })}

                              {provider.endpoints?.length > 0 && (
                                <div className="flex flex-wrap gap-2 px-1 pb-1">
                                  {provider.endpoints.map((endpoint) => {
                                    const isEndpointSelected =
                                      (config.provider === provider.id && config.apiEndpoint) === endpoint.url ||
                                      (!config.apiEndpoint && endpoint === provider.endpoints[0]);

                                    return (
                                      <button
                                        key={endpoint.id}
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleEndpointSelect(categoryId, provider, endpoint.url);
                                        }}
                                        className={cn(
                                          "text-[11px] px-3 py-1.5 rounded-full transition-colors bg-slate-900/70 hover:bg-slate-800/80 text-slate-200 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]",
                                          isEndpointSelected &&
                                            "ring-1 ring-indigo-400/60 text-indigo-200 bg-indigo-900/40 shadow-[0_0_0_1px_rgba(129,140,248,0.3)]"
                                        )}
                                      >
                                        {endpoint.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </motion.div>
                          )}
                      </AnimatePresence>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
LLMProviderDropdown.propTypes = {
  config: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ============================================
// 🧠 Algorithm Strategy Controls
// ============================================
function AlgorithmRow({ config, onChange }) {
  const algorithmMode = config.algorithmMode || "none"; // none | llm_only | algo_only | llm_plus_algo
  const algorithm = config.algorithm ?? "none";
  const algorithmParams = config.algorithmParams || {};

  const showAlgorithmUI = config.type === "llm" || algorithmMode === "algo_only";
  if (!showAlgorithmUI) return null;

  const setMode = (mode) => {
    const next = {
      ...config,
      algorithmMode: mode,
      algorithm: mode === "llm_only" || mode === "none" ? "none" : (config.algorithm ?? "mcts"),
      algorithmParams: config.algorithmParams || {},
    };
    if (mode === "algo_only" && next.type !== "llm") next.type = "llm";
    onChange(next);
  };

  const handleAlgorithmChange = (value) => {
    onChange({
      ...config,
      algorithm: value,
      algorithmParams,
      algorithmMode:
        config.algorithmMode && config.algorithmMode !== "none"
          ? config.algorithmMode
          : value === "none"
            ? "llm_only"
            : "llm_plus_algo",
    });
  };

  const showParams = algorithm !== "none" && (algorithmMode === "algo_only" || algorithmMode === "llm_plus_algo");

  return (
    <div className="mt-4 rounded-2xl bg-slate-950/60 ring-1 ring-white/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-fuchsia-500/20 to-indigo-500/20 flex items-center justify-center">
          <Brain size={16} className="text-fuchsia-300" />
        </div>
        <div>
          <div className="text-sm font-bold text-slate-100">Strategy</div>
          <div className="text-[11px] text-slate-500">Choose LLM, Algorithm, or both</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { id: "llm_only", label: "LLM Only" },
          { id: "algo_only", label: "Algorithm Only" },
          { id: "llm_plus_algo", label: "LLM + Algorithm" },
        ].map((opt) => {
          const active = algorithmMode === opt.id || (algorithmMode === "none" && opt.id === "llm_only");
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setMode(opt.id)}
              className={cn(
                "px-3 py-2 rounded-xl text-xs font-semibold transition-all shadow-[0_0_0_1px_rgba(255,255,255,0.06)]",
                active
                  ? "bg-indigo-500/25 text-indigo-100 ring-1 ring-indigo-400/40"
                  : "bg-slate-900/60 text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-400">Algorithm</div>
        <div className="relative">
          <select
            value={algorithm}
            onChange={(e) => handleAlgorithmChange(e.target.value)}
            disabled={algorithmMode === "llm_only"}
            className={cn(
              "w-full px-3 py-2.5 rounded-xl bg-slate-900/75 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] appearance-none",
              algorithmMode === "llm_only" && "opacity-60 cursor-not-allowed"
            )}
          >
            {ALGORITHMS.map((a) => (
              <option key={a.id} value={a.id} className="bg-slate-900 text-slate-100">
                {a.label}
              </option>
            ))}
          </select>
          <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
        </div>
      </div>

      {showParams && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 mb-1">Depth</div>
            <input
              type="number"
              min={1}
              max={10}
              value={Number(algorithmParams.depth ?? 2)}
              onChange={(e) =>
                onChange({
                  ...config,
                  algorithmParams: { ...algorithmParams, depth: Number(e.target.value) },
                })
              }
              className="w-full px-3 py-2 rounded-xl bg-slate-950/70 text-sm text-slate-100 ring-1 ring-white/5 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
            />
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-500 mb-1">Simulations</div>
            <input
              type="number"
              min={10}
              max={5000}
              step={10}
              value={Number(algorithmParams.sims ?? 200)}
              onChange={(e) =>
                onChange({
                  ...config,
                  algorithmParams: { ...algorithmParams, sims: Number(e.target.value) },
                })
              }
              className="w-full px-3 py-2 rounded-xl bg-slate-950/70 text-sm text-slate-100 ring-1 ring-white/5 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
            />
          </div>
        </div>
      )}
    </div>
  );
}
AlgorithmRow.propTypes = { config: PropTypes.object.isRequired, onChange: PropTypes.func.isRequired };

// ============================================
// Player Configuration Card
// ============================================
function PlayerConfigCard({ playerId, config, onChange }) {
  const color = getPlayerColor(playerId);
  const [showDropdown, setShowDropdown] = useState(false);

  const apiKey = config.apiKey || "";
  const apiKeyStatus = config.apiKeyStatus || "idle";
  const apiKeyStatusMessage = config.apiKeyMessage || "";
  const isVerifying = apiKeyStatus === "checking";
  const { required: apiKeyRequired, isValid: apiKeyValid, message: apiKeyMessage } =
    getApiKeyValidation(config.providerCategory, config.provider, apiKey);

  const showApiKeySection =
    config.type === "llm" && config.provider && providerRequiresApiKey(config.providerCategory, config.provider);

  const providerMeta =
    config.providerCategory && config.provider ? findProvider(config.providerCategory, config.provider) : null;

  const endpointOptions = providerMeta?.endpoints || [];
  const effectiveEndpoint = config.apiEndpoint || (endpointOptions.length > 0 ? endpointOptions[0].url : "");
  const modelOptions = providerMeta?.models || [];
  const selectedModel = config.model || (modelOptions[0] || "");

  const handleTypeToggle = (type) => {
    const next = {
      ...config,
      type,
      provider: type === "human" ? null : config.provider,
      model: type === "human" ? null : config.model,
    };

    if (type === "human") {
      next.algorithmMode = "none";
      next.algorithm = "none";
      next.algorithmParams = {};
      setShowDropdown(false);
    } else {
      next.algorithmMode = next.algorithmMode || "llm_only";
      next.algorithm = next.algorithm ?? "none";
      next.algorithmParams = next.algorithmParams || {};
    }

    onChange(next);
  };

  const handleVerifyApiKey = async () => {
    if (!config.provider) {
      onChange({ ...config, apiKeyStatus: "invalid", apiKeyMessage: "Select a provider before verifying." });
      return;
    }
    if (!apiKey && apiKeyRequired) {
      onChange({ ...config, apiKeyStatus: "invalid", apiKeyMessage: "Enter an API key to verify." });
      return;
    }

    onChange({ ...config, apiKeyStatus: "checking", apiKeyMessage: "Verifying key with provider..." });

    try {
      const res = await fetch(`${API_BASE}/api/llm/verify-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: config.provider,
          apiKey,
          apiEndpoint: effectiveEndpoint,
        }),
      });
      const data = await res.json();
      if (data.ok) onChange({ ...config, apiKeyStatus: "valid", apiKeyMessage: data.message || "API key verified successfully." });
      else onChange({ ...config, apiKeyStatus: "invalid", apiKeyMessage: data.error || "Verification failed." });
    } catch {
      onChange({ ...config, apiKeyStatus: "invalid", apiKeyMessage: "Network error while verifying." });
    }
  };

  const subtitle = useMemo(() => {
    const mode = config.algorithmMode || "none";
    const algo = config.algorithm || "none";
    const label = (ALGORITHMS.find((a) => a.id === algo)?.label) || algo;

    if (config.type === "human") return "Human Player";
    if (!config.provider && mode !== "algo_only") return "Select AI Provider";

    if (mode === "algo_only") return `Algorithm Only — ${label}`;
    if (mode === "llm_plus_algo" && algo !== "none") return `${config.providerName || config.provider} — ${config.model} + ${label}`;
    return `${config.providerName || config.provider} - ${config.model}`;
  }, [config]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: playerId * 0.05 }}
      className="relative rounded-2xl p-5 transition-all"
      style={{
        background: `linear-gradient(135deg, ${color.primary}15, ${color.primary}05)`,
        borderLeft: `4px solid ${color.primary}`,
        boxShadow: `0 4px 20px ${color.primary}10`,
      }}
    >
      <div className="flex items-center gap-4">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg shadow-lg flex-shrink-0"
          style={{
            background: `linear-gradient(135deg, ${color.primary}, ${color.dark})`,
            color: "white",
            boxShadow: `0 6px 16px ${color.primary}50`,
          }}
        >
          {playerId + 1}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-base font-bold text-slate-100">Player {playerId + 1}</div>
          <div className="text-sm text-slate-400 truncate mt-0.5">{subtitle}</div>
        </div>

        <div className="flex items-center gap-1.5 p-1.5 rounded-xl bg-slate-900/70 flex-shrink-0">
          <button
            onClick={() => handleTypeToggle("human")}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200",
              config.type === "human"
                ? "bg-slate-600 text-slate-100 shadow-lg"
                : "text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
            )}
          >
            <User size={16} weight={config.type === "human" ? "fill" : "regular"} />
            Human
          </button>
          <button
            onClick={() => handleTypeToggle("llm")}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200",
              config.type === "llm"
                ? "bg-indigo-500/30 text-indigo-200 shadow-lg ring-1 ring-indigo-400/40"
                : "text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
            )}
          >
            <Robot size={16} weight={config.type === "llm" ? "fill" : "regular"} />
            AI
          </button>
        </div>
      </div>

      {/* ✅ Strategy row */}
      <AlgorithmRow config={config} onChange={onChange} />

      <AnimatePresence>
        {config.type === "llm" && (config.algorithmMode || "llm_only") !== "algo_only" && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-visible mt-5"
          >
            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="w-full flex items-center justify-between gap-4 px-5 py-3.5 rounded-2xl bg-slate-950/70 hover:bg-slate-900/80 shadow-md shadow-black/40 transition-all duration-200 text-left group"
              >
                {config.provider ? (
                  <div className="flex items-center gap-4">
                    <ProviderLogo providerId={config.provider} size={28} />
                    <div className="flex flex-col">
                      <span className="text-base font-semibold text-slate-200">
                        {config.providerName || config.provider}
                      </span>
                      <span className="text-sm text-slate-500">{config.model}</span>
                    </div>
                  </div>
                ) : (
                  <span className="text-base text-slate-400">Select AI Provider...</span>
                )}
                <CaretDown
                  size={18}
                  weight="bold"
                  className={cn(
                    "text-slate-400 transition-all duration-200 group-hover:text-slate-300",
                    showDropdown && "rotate-180 text-indigo-400"
                  )}
                />
              </button>

              <AnimatePresence>
                {showDropdown && (
                  <LLMProviderDropdown config={config} onChange={onChange} onClose={() => setShowDropdown(false)} />
                )}
              </AnimatePresence>
            </div>

            {/* Endpoint & API key configuration */}
            {showApiKeySection && (
              <div className="mt-4 space-y-3">
                {modelOptions.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-slate-400">Model</span>
                    </div>
                    <div className="relative">
                      {config.provider && (
                        <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 flex items-center">
                          <ProviderLogo providerId={config.provider} size={14} />
                        </div>
                      )}
                      <select
                        value={selectedModel}
                        onChange={(e) => onChange({ ...config, model: e.target.value })}
                        className={cn(
                          "w-full px-3 py-2.5 rounded-xl bg-slate-900/80 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] appearance-none",
                          config.provider && "pl-10"
                        )}
                      >
                        {modelOptions.map((m) => (
                          <option key={m} value={m} className="bg-slate-900 text-slate-100">
                            {m}
                          </option>
                        ))}
                      </select>
                      <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    </div>
                  </div>
                )}

                {endpointOptions.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-slate-400">Model API endpoint</span>
                    </div>
                    <div className="relative">
                      {config.provider && (
                        <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 flex items-center">
                          <ProviderLogo providerId={config.provider} size={14} />
                        </div>
                      )}
                      <select
                        value={effectiveEndpoint}
                        onChange={(e) => onChange({ ...config, apiEndpoint: e.target.value })}
                        className={cn(
                          "w-full px-3 py-2.5 rounded-xl bg-slate-900/80 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] appearance-none",
                          config.provider && "pl-10"
                        )}
                      >
                        {endpointOptions.map((opt) => (
                          <option key={opt.id} value={opt.url} className="bg-slate-900 text-slate-100">
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-400">API key</span>
                  {(apiKeyStatus !== "idle" || apiKey) && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]",
                        apiKeyStatus === "valid" && "bg-emerald-500/10 text-emerald-300",
                        apiKeyStatus === "invalid" && "bg-amber-500/10 text-amber-300",
                        apiKeyStatus === "checking" && "bg-indigo-500/10 text-indigo-200",
                        apiKeyStatus === "idle" && "bg-slate-800/70 text-slate-300"
                      )}
                    >
                      <Key
                        size={10}
                        className={
                          apiKeyStatus === "valid"
                            ? "text-emerald-400"
                            : apiKeyStatus === "invalid"
                              ? "text-amber-400"
                              : "text-indigo-300"
                        }
                      />
                      {apiKeyStatusMessage ||
                        (apiKeyStatus === "valid"
                          ? "Verified"
                          : apiKeyStatus === "invalid"
                            ? "Check key"
                            : apiKeyStatus === "checking"
                              ? "Verifying..."
                              : apiKeyValid
                                ? "Looks good"
                                : "Enter key")}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        apiKey: e.target.value,
                        apiKeyStatus: "idle",
                        apiKeyMessage: "",
                      })
                    }
                    placeholder="Paste your API key - stored only in this browser"
                    className="w-full px-3 py-2.5 rounded-xl bg-slate-950/80 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
                  />
                  <button
                    type="button"
                    onClick={handleVerifyApiKey}
                    disabled={isVerifying || (!apiKey && apiKeyRequired) || !config.provider}
                    className={cn(
                      "flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 shadow-[0_6px_14px_rgba(0,0,0,0.4)]",
                      isVerifying
                        ? "bg-indigo-500/30 text-indigo-100"
                        : "bg-slate-800/70 text-slate-200 hover:bg-slate-700/70",
                      (isVerifying || (!apiKey && apiKeyRequired) || !config.provider) &&
                        "opacity-60 cursor-not-allowed hover:bg-slate-800/70"
                    )}
                  >
                    <Key size={14} />
                    {isVerifying ? "Verifying..." : "Verify"}
                  </button>
                </div>

                {apiKeyRequired && (
                  <p className={cn("mt-1.5 text-[11px]", apiKeyValid ? "text-emerald-400" : "text-amber-300")}>
                    {apiKeyStatusMessage || apiKeyMessage}
                  </p>
                )}
                {!apiKeyRequired && apiKeyStatusMessage && (
                  <p className="mt-1.5 text-[11px] text-slate-400">{apiKeyStatusMessage}</p>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
PlayerConfigCard.propTypes = {
  playerId: PropTypes.number.isRequired,
  config: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
};

// ============================================
// Large Board Preview
// ============================================
function LargeBoardPreview({ board, bbox, onRerandomize }) {
  return (
    <div className="h-full flex flex-col gap-3">
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center">
            <Hexagon size={20} weight="fill" className="text-amber-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-200">Board Preview</h3>
            <p className="text-xs text-slate-500">Click shuffle to generate a new map</p>
          </div>
        </div>
        <button
          onClick={onRerandomize}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800/90 transition-all shadow-lg shadow-black/30"
        >
          <Shuffle size={16} />
          Shuffle
        </button>
      </div>

      <div
        className="relative w-full rounded-3xl overflow-hidden bg-gradient-to-br from-slate-900 to-slate-950 shadow-2xl shadow-black/40"
        style={{ height: "min(52vh, 440px)", minHeight: "320px" }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`${bbox.minX} ${bbox.minY} ${bbox.width} ${bbox.height}`}
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full"
        >
          <defs>
            <filter id="hexShadowLarge" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.4" />
            </filter>
          </defs>

          {board.tiles.map((t, idx) => {
            const pts = Array.from({ length: 6 }, (_, i) => hexCorner(t.center, TILE_SIZE, i));
            const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ") + " Z";
            const isHot = t.number === 6 || t.number === 8;

            return (
              <g key={idx}>
                <path
                  d={path}
                  fill={resourceColor(t.resource)}
                  stroke="rgba(0,0,0,0.4)"
                  strokeWidth={1.5}
                  filter="url(#hexShadowLarge)"
                />
                {t.number && t.resource !== "desert" && (
                  <>
                    <circle
                      cx={t.center.x}
                      cy={t.center.y}
                      r={12}
                      fill="#1e293b"
                      stroke={isHot ? "rgba(239,68,68,0.5)" : "rgba(51,65,85,0.5)"}
                      strokeWidth={1}
                    />
                    <text
                      x={t.center.x}
                      y={t.center.y + 1}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill={isHot ? "#ef4444" : "#f8fafc"}
                      fontSize="10"
                      fontWeight="bold"
                      fontFamily="system-ui, sans-serif"
                    >
                      {t.number}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
LargeBoardPreview.propTypes = {
  board: PropTypes.object.isRequired,
  bbox: PropTypes.object.isRequired,
  onRerandomize: PropTypes.func.isRequired,
};

// ============================================
// Main Setup Screen Component
// ============================================
export function SetupScreen({
  numPlayers,
  setNumPlayers,
  playerConfigs = [],
  setPlayerConfigs,
  onStart,
  onRerandomize,
  board,
  bbox,
}) {
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 4;

  const defaultConfig = () => ({
    type: "human",
    provider: null,
    providerCategory: null,
    providerName: null,
    model: null,
    apiKey: "",
    apiEndpoint: "",
    apiKeyStatus: "idle",
    apiKeyMessage: "",

    algorithmMode: "none", // none | llm_only | algo_only | llm_plus_algo
    algorithm: "none",
    algorithmParams: {},
  });

  const configs =
    playerConfigs.length >= numPlayers
      ? playerConfigs
      : Array.from({ length: numPlayers }, (_, i) => playerConfigs[i] || defaultConfig());

  const handlePlayerCountChange = (count) => {
    setNumPlayers(count);
    const newConfigs = Array.from({ length: count }, (_, i) => configs[i] || defaultConfig());
    setPlayerConfigs?.(newConfigs);
  };

  const handlePlayerConfigChange = (index, config) => {
    const newConfigs = [...configs];
    newConfigs[index] = config;
    setPlayerConfigs?.(newConfigs);
  };

  const aiCount = configs.filter((c) => c?.type === "llm").length;
  const humanCount = numPlayers - aiCount;

  const canStart = configs.every((c) => {
    if (!c || c.type !== "llm") return true;

    const mode = c.algorithmMode || "none";
    if (mode === "algo_only") {
      return c.algorithm && c.algorithm !== "none";
    }

    if (!c.provider || !c.model) return false;
    const { required, isValid } = getApiKeyValidation(c.providerCategory, c.provider, c.apiKey);
    return !required || isValid;
  });

  return (
    <div className="min-h-screen px-4 py-6 lg:px-8 lg:py-8 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-sm text-slate-200">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-500/3 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 w-full max-w-6xl mx-auto"
      >
        <div className="text-center mb-8">
          <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="inline-flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-xl shadow-amber-500/30">
              <Hexagon size={24} weight="fill" className="text-white" />
            </div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-100">Settlers of Catan</h1>
          </motion.div>
          <p className="text-slate-500 text-sm">Configure players and start your game</p>
        </div>

        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-3xl p-6 lg:p-7 w-full lg:flex-1 min-w-0"
            style={{
              background: "linear-gradient(135deg, rgba(30, 41, 59, 0.72), rgba(15, 23, 42, 0.88))",
              boxShadow: "0 25px 60px -14px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
            }}
          >
            <div className="h-full flex flex-col">
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
                    <Users size={18} className="text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-200">Number of Players</h3>
                    <p className="text-xs text-slate-500">Select how many will compete</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
                    <button
                      key={n}
                      onClick={() => handlePlayerCountChange(n)}
                      className={cn(
                        "py-3.5 rounded-xl font-semibold text-base transition-all duration-200",
                        numPlayers === n
                          ? "bg-slate-900/80 text-slate-50 shadow-lg shadow-indigo-500/25"
                          : "bg-slate-900/60 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200"
                      )}
                    >
                      {n} Players
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-px bg-gradient-to-r from-transparent via-slate-700/50 to-transparent my-2" />

              <div className="flex-1 overflow-y-auto">
                <div className="flex items-center gap-3 mb-4 mt-4">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center">
                    <Gear size={20} className="text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-200">Player Configuration</h3>
                    <p className="text-xs text-slate-500">Choose human or AI for each player</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {Array.from({ length: numPlayers }, (_, i) => (
                    <PlayerConfigCard
                      key={i}
                      playerId={i}
                      config={configs[i] || defaultConfig()}
                      onChange={(cfg) => handlePlayerConfigChange(i, cfg)}
                    />
                  ))}
                </div>
              </div>

              <div className="h-px bg-gradient-to-r from-transparent via-slate-700/50 to-transparent my-6" />

              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800/60 text-sm">
                    <GameController size={16} className="text-slate-400" />
                    <span className="text-slate-300 font-medium">{numPlayers} players</span>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800/60 text-sm">
                    <User size={16} className="text-blue-400" />
                    <span className="text-slate-300 font-medium">{humanCount} human</span>
                  </div>
                  {aiCount > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/20 text-sm">
                      <Robot size={16} className="text-indigo-400" />
                      <span className="text-indigo-300 font-medium">{aiCount} AI</span>
                    </div>
                  )}
                </div>

                {!canStart && aiCount > 0 && (
                  <div className="flex items-center gap-2 mb-3 text-xs text-amber-300">
                    <WarningCircle size={14} className="text-amber-400" />
                    <span>Finish configuring AI players to enable starting the game.</span>
                  </div>
                )}

                <button
                  onClick={onStart}
                  disabled={!canStart}
                  className={cn(
                    "w-full flex items-center justify-center gap-3 py-4 rounded-xl font-bold text-base text-white transition-all hover:scale-[1.02] active:scale-[0.98]",
                    !canStart && "opacity-60 cursor-not-allowed hover:scale-100"
                  )}
                  style={{
                    background: "linear-gradient(135deg, #10b981, #059669)",
                    boxShadow: "0 12px 30px -5px rgba(16, 185, 129, 0.4)",
                  }}
                >
                  <Play size={20} weight="fill" />
                  Start Game
                  <Sparkle size={18} weight="fill" className="text-emerald-200" />
                </button>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 }}
            className="rounded-3xl p-5 lg:p-6 w-full lg:w-[420px] xl:w-[520px] flex-shrink-0 lg:sticky lg:top-8"
            style={{
              background: "linear-gradient(135deg, rgba(30, 41, 59, 0.72), rgba(15, 23, 42, 0.9))",
              boxShadow: "0 25px 60px -14px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
            }}
          >
            <LargeBoardPreview board={board} bbox={bbox} onRerandomize={onRerandomize} />
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}

SetupScreen.propTypes = {
  numPlayers: PropTypes.number.isRequired,
  setNumPlayers: PropTypes.func.isRequired,
  playerConfigs: PropTypes.array,
  setPlayerConfigs: PropTypes.func,
  onStart: PropTypes.func.isRequired,
  onRerandomize: PropTypes.func.isRequired,
  board: PropTypes.object.isRequired,
  bbox: PropTypes.object.isRequired,
};

export default SetupScreen;
