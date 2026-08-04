import type { ComponentType } from "react";
import { ClaudeLogo } from "./claude";
import { GeminiLogo } from "./gemini";
import { GitHubCopilotLogo } from "./github-copilot";
import { OpenAiLogo } from "./openai";
import { OpenRouterLogo } from "./openrouter";
import { QwenLogo } from "./qwen";
import type { ProviderLogoProps } from "./types";
import { XaiLogo } from "./xai";

export type { ProviderLogoProps } from "./types";

export const providerLogos: Record<
  string,
  ComponentType<ProviderLogoProps> | undefined
> = {
  claude: ClaudeLogo,
  gemini: GeminiLogo,
  "github-copilot": GitHubCopilotLogo,
  openai: OpenAiLogo,
  openrouter: OpenRouterLogo,
  qwen: QwenLogo,
  xai: XaiLogo,
};
