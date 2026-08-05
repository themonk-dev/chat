import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGroup } from "@/lib/oauth/model-catalog";
import { ModelSelectorCompact } from "./model-selector-compact";

vi.mock("@/hooks/use-active-chat", () => ({
  getSelectionProviderId: () => "openai",
}));

vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => ({ setActiveId: () => undefined }),
}));

/** What OpenRouter's listing really is: its whole catalogue, 338 entries. */
const manyModels = Array.from({ length: 338 }, (_, i) => ({
  id: `vendor/model-${i}`,
  name: `Vendor Model ${i}`,
}));

const groups: ModelGroup[] = [
  {
    models: [{ id: "gpt-5-codex", name: "GPT-5 Codex" }],
    providerId: "openai",
  },
  { models: manyModels, providerId: "openrouter" },
  { models: [{ id: "grok-4", name: "Grok 4" }], providerId: "xai" },
];

globalThis.ResizeObserver ??= class {
  disconnect() {
    // nothing observed
  }
  observe() {
    // nothing observed
  }
  unobserve() {
    // nothing observed
  }
};

// Radix's popover asks for these before it will open, and jsdom has none.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

describe("the model picker's groups", () => {
  afterEach(() => {
    cleanup();
  });

  function openPicker(selectedModelId: string) {
    render(
      <ModelSelectorCompact groups={groups} selectedModelId={selectedModelId} />
    );

    act(() => {
      fireEvent.click(screen.getByTestId("model-selector"));
    });
  }

  /**
   * The report this exists for: "models from other providers do not appear,
   * they seem filtered by the selected model's provider". Nothing filtered —
   * OpenRouter's 338 rows sat between ChatGPT and everyone else in a 280px
   * list, so every provider below it was several hundred rows out of view.
   */
  it("keeps every provider reachable when one lists hundreds of models", () => {
    openPicker("gpt-5-codex");

    // The selection's own name is also in the trigger, hence queryAll.
    expect(screen.queryAllByText("GPT-5 Codex").length).toBeGreaterThan(0);
    expect(screen.queryByText("Grok 4")).toBeTruthy();
    expect(screen.queryByText("OpenRouter")).toBeTruthy();
    expect(screen.queryByText("Grok")).toBeTruthy();
  });

  it("says how many it is holding back rather than silently truncating", () => {
    openPicker("gpt-5-codex");

    expect(screen.queryByText("330 more — type to search")).toBeTruthy();
  });

  it("shows a selection the slice would have cut, so the tick is never lost", () => {
    openPicker("vendor/model-300");

    expect(screen.queryAllByText("Vendor Model 300").length).toBeGreaterThan(0);
  });

  it("drops the slice once there is a search for cmdk to filter on", () => {
    openPicker("gpt-5-codex");

    act(() => {
      fireEvent.change(screen.getByPlaceholderText("Search models..."), {
        target: { value: "Vendor Model 300" },
      });
    });

    expect(screen.queryByText(/more — type to search/)).toBeNull();
    expect(screen.queryAllByText("Vendor Model 300").length).toBeGreaterThan(0);
  });
});
