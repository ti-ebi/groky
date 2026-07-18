import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type AppearancePreference = "system" | "light" | "dark";
export type ResolvedAppearance = Exclude<AppearancePreference, "system">;

const APPEARANCE_STORAGE_KEY = "groky.appearance";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function parseAppearancePreference(value: string | null): AppearancePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveAppearance(
  preference: AppearancePreference,
  systemAppearance: ResolvedAppearance,
): ResolvedAppearance {
  return preference === "system" ? systemAppearance : preference;
}

function systemAppearance(): ResolvedAppearance {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

function storedAppearance(): AppearancePreference {
  try {
    return parseAppearancePreference(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function applyAppearance(appearance: ResolvedAppearance) {
  document.documentElement.dataset.theme = appearance;
}

export function initializeAppearance() {
  applyAppearance(resolveAppearance(storedAppearance(), systemAppearance()));
}

export function useAppearance() {
  const [preference, setPreference] = useState<AppearancePreference>(storedAppearance);
  const [system, setSystem] = useState<ResolvedAppearance>(systemAppearance);
  const resolved = resolveAppearance(preference, system);

  useEffect(() => {
    const colorScheme = window.matchMedia(DARK_SCHEME_QUERY);
    const updateSystemAppearance = (event: MediaQueryListEvent) => {
      setSystem(event.matches ? "dark" : "light");
    };
    colorScheme.addEventListener("change", updateSystemAppearance);
    return () => colorScheme.removeEventListener("change", updateSystemAppearance);
  }, []);

  useLayoutEffect(() => {
    applyAppearance(resolved);
  }, [resolved]);

  const updatePreference = useCallback((next: AppearancePreference) => {
    setPreference(next);
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
    } catch {
      // The active choice still applies when persistent browser storage is unavailable.
    }
  }, []);

  return { preference, resolved, setPreference: updatePreference };
}
