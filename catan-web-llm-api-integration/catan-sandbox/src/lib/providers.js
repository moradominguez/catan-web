// ============================================
// AI Provider Icons & Utilities
// Shared across setup screen and game components
// ============================================
import {
  AlibabaCloud,
  DeepSeek,
  Meta,
  Mistral,
  Moonshot,
  Minimax,
  Zhipu,
  Ollama,
  OpenAI,
  Claude,
  Gemini,
  XAI,
  OpenRouter,
  Together,
  HuggingFace,
} from "@lobehub/icons";

// Provider icon mapping with @lobehub/icons
export const PROVIDER_ICONS = {
  alibaba: AlibabaCloud,
  deepseek: DeepSeek,
  meta: Meta,
  mistral: Mistral,
  moonshot: Moonshot,
  minimax: Minimax,
  zhipu: Zhipu,
  huggingface: HuggingFace,
  ollama: Ollama,
  openai: OpenAI,
  anthropic: Claude,
  google: Gemini,
  xai: XAI,
  openrouter: OpenRouter,
  together: Together,
};

// Provider color mapping
export const PROVIDER_COLORS = {
  alibaba: "#ff6a00",
  deepseek: "#0066ff",
  meta: "#0668E1",
  mistral: "#6B4FBB",
  moonshot: "#4ecdc4",
  minimax: "#ff6b6b",
  zhipu: "#00a8e8",
   // Hugging Face brand yellow-ish / emoji tone
  huggingface: "#ffcc4d",
  ollama: "#00d4aa",
  openai: "#10a37f",
  anthropic: "#d97757",
  google: "#4285f4",
  xai: "#1da1f2",
  openrouter: "#6366f1",
  together: "#8b5cf6",
};

// Get provider icon component
export function getProviderIcon(providerId) {
  return PROVIDER_ICONS[providerId] || null;
}

// Get provider color
export function getProviderColor(providerId) {
  return PROVIDER_COLORS[providerId] || "#666";
}

// Providers whose brand marks look best as white monochrome on dark backgrounds.
export const WHITE_LOGO_PROVIDERS = ["moonshot", "ollama", "xai", "openai"];

// LLM Provider Categories Configuration
export const LLM_CATEGORIES = {
  openSource: {
    label: "Open Source",
    color: "#22c55e",
    providers: [
      { id: "alibaba", name: "Alibaba Cloud", models: ["Qwen3", "Qwen2.5", "Qwen-Max"] },
      { id: "deepseek", name: "DeepSeek", models: ["DeepSeek V3", "DeepSeek R1"] },
      { id: "meta", name: "Meta AI", models: ["Llama 4", "Llama 3.3"] },
      { id: "mistral", name: "MistralAI", models: ["Magistral Medium", "Mistral Large"] },
      {
        id: "moonshot",
        name: "Moonshot AI",
        models: ["Kimi K2"],
        endpoints: [
          {
            id: "moonshot-default",
            label: "Moonshot API (api.moonshot.cn)",
            url: "https://api.moonshot.cn",
          },
        ],
      },
      { id: "minimax", name: "Minimax", models: ["M2"] },
      { id: "zhipu", name: "Z.AI (Zhipu)", models: ["GLM-4.6", "GLM-4"] },
      {
        id: "huggingface",
        name: "Hugging Face",
        models: ["Mistral 7B", "Llama 3.1 8B", "Mixtral 8x7B"],
        endpoints: [
          {
            id: "hf-inference",
            label: "Inference API (api-inference.huggingface.co)",
            url: "https://api-inference.huggingface.co",
          },
        ],
      },
      {
        id: "ollama",
        name: "Ollama (Local)",
        models: ["llama3.2", "mistral", "phi3"],
        local: true,
        endpoints: [
          {
              id: "ollama-local",
              label: "Ollama Local (http://localhost:11434/v1)",
              url: "http://localhost:11434/v1",
            
          },
        ],
      },
    ],
  },
  closedSource: {
    label: "Closed Source",
    color: "#a855f7",
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        models: ["gpt-5-nano-2025-08-07", "GPT-4o", "GPT-4 Turbo", "o1-preview"],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        // Concrete Claude 4.x model IDs users can point at.
        models: [
          "claude-haiku-4-5-20251001",
          "claude-sonnet-4-5-20250929",
          "claude-opus-4-1-20250805",
          "claude-opus-4-5-20251101",
        ],
        endpoints: [
          {
            id: "anthropic-default",
            label: "Anthropic API (api.anthropic.com)",
            url: "https://api.anthropic.com",
          },
        ],
      },
      {
        id: "google",
        name: "Google Gemini",
        models: ["gemini-2.5-flash-lite", "Gemini 2.0 Pro", "Gemini 1.5 Pro"],
        endpoints: [
          {
            id: "gemini-default",
            label: "Gemini (OpenAI compatible)",
            url: "https://generativelanguage.googleapis.com/v1beta/openai",
          },
        ],
      },
      {
        id: "xai",
        name: "xAI",
        models: ["Grok-2", "Grok-1.5"],
        endpoints: [
          {
            id: "xai-default",
            label: "xAI API (api.x.ai)",
            url: "https://api.x.ai",
          },
        ],
      },
    ],
  },
  // Aggregator-style providers (OpenRouter, Together, etc.) are intentionally
  // omitted from the setup UI for now to keep the provider list focused.
  // They can be reintroduced later if we add first-class support.
};
