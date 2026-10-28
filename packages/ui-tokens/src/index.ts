/* Modified for Saturn bot: Saturn UI and localization adaptations from the recorded upstream snapshot. See PROVENANCE.md. */
export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/** Owner-selected Saturn brand, shared by every surface. */
export const SATURN_BRAND = {
  navy: "#14213D",
  gold: "#D6A24A",
  ivory: "#FFF9EF",
  night: "#0B1220",
  readableGold: "#8A5A15",
} as const;

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  /** Backing behind a link's site icon. White in both themes so dark logos stay visible. */
  faviconPlate: string;
  success: string;
  warning: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

export const darkTokens = {
  background: SATURN_BRAND.night,
  foreground: SATURN_BRAND.ivory,
  card: "#121D30",
  cardForeground: SATURN_BRAND.ivory,
  popover: "#121D30",
  popoverForeground: SATURN_BRAND.ivory,
  primary: SATURN_BRAND.gold,
  primaryForeground: SATURN_BRAND.navy,
  secondary: "#19263B",
  secondaryForeground: SATURN_BRAND.ivory,
  chatUser: "#263653",
  chatUserForeground: SATURN_BRAND.ivory,
  muted: "#121D30",
  mutedForeground: "#A4ACBA",
  accent: "#23324A",
  accentForeground: SATURN_BRAND.ivory,
  destructive: "#EF4444",
  destructiveForeground: "#FFFFFF",
  border: "#2B3950",
  input: "#19263B",
  ring: SATURN_BRAND.gold,
  sidebar: "#0F192B",
  sidebarForeground: SATURN_BRAND.ivory,
  sidebarBorder: "#29364B",
  sidebarAccent: "#23324A",
  sidebarAccentForeground: SATURN_BRAND.ivory,
  link: "#EBC478",
  faviconPlate: "#FFFFFF",
  success: "#4ECB71",
  warning: "#E9C46A",
  overlay: "rgba(4, 4, 5, 0.72)",
  scrollbar: "#2B3950",
  scrollbarHover: "#485774",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: SATURN_BRAND.ivory,
  foreground: SATURN_BRAND.navy,
  card: "#FFFFFF",
  cardForeground: SATURN_BRAND.navy,
  popover: "#FFFFFF",
  popoverForeground: SATURN_BRAND.navy,
  primary: SATURN_BRAND.navy,
  primaryForeground: SATURN_BRAND.ivory,
  secondary: "#F4EADB",
  secondaryForeground: SATURN_BRAND.navy,
  chatUser: "#F4E1BB",
  chatUserForeground: SATURN_BRAND.navy,
  muted: "#F4EADB",
  mutedForeground: "#5F6877",
  accent: "#F5E5C5",
  accentForeground: SATURN_BRAND.navy,
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#E4D8C8",
  input: "#E4D8C8",
  ring: SATURN_BRAND.readableGold,
  sidebar: "#F4EADB",
  sidebarForeground: SATURN_BRAND.navy,
  sidebarBorder: "#E4D8C8",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: SATURN_BRAND.navy,
  link: SATURN_BRAND.readableGold,
  faviconPlate: "#FFFFFF",
  success: "#228B3B",
  warning: "#B7791F",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#D7C5AA",
  scrollbarHover: "#B49B74",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export const PLANET_IDS = [
  "saturn",
  "sun",
  "mercury",
  "venus",
  "earth",
  "mars",
  "jupiter",
  "uranus",
  "neptune",
  "moon",
  "pluto",
  "ceres",
] as const;

export type PlanetId = (typeof PLANET_IDS)[number];

export const PLANET_GRADIENT_TOKENS: Record<PlanetId, string> = {
  sun: "radial-gradient(circle at 35% 30%, oklch(0.93 0.13 95), oklch(0.78 0.17 65))",
  mercury: "radial-gradient(circle at 35% 30%, oklch(0.82 0.01 70), oklch(0.58 0.015 60))",
  venus: "radial-gradient(circle at 35% 30%, oklch(0.9 0.07 85), oklch(0.74 0.11 70))",
  earth: "radial-gradient(circle at 35% 30%, oklch(0.75 0.11 230), oklch(0.5 0.13 250))",
  mars: "radial-gradient(circle at 35% 30%, oklch(0.75 0.13 45), oklch(0.55 0.16 35))",
  jupiter: "repeating-linear-gradient(170deg, oklch(0.85 0.06 70) 0 14%, oklch(0.72 0.09 55) 14% 22%, oklch(0.88 0.04 80) 22% 34%)",
  saturn: "radial-gradient(circle at 35% 30%, oklch(0.92 0.07 90), oklch(0.76 0.09 75))",
  uranus: "radial-gradient(circle at 35% 30%, oklch(0.9 0.06 200), oklch(0.72 0.08 205))",
  neptune: "radial-gradient(circle at 35% 30%, oklch(0.7 0.13 260), oklch(0.45 0.16 265))",
  moon: "radial-gradient(circle at 35% 30%, oklch(0.93 0.005 260), oklch(0.7 0.01 260))",
  pluto: "radial-gradient(circle at 35% 30%, oklch(0.88 0.04 60), oklch(0.66 0.06 45))",
  ceres: "radial-gradient(circle at 35% 30%, oklch(0.78 0.01 250), oklch(0.55 0.015 250))",
};

export const SATURN_ACCENT_TOKENS = {
  radiusSaturn: "0.875rem",
  eye: "oklch(1 0 0)",
  pupil: "oklch(0.16 0.005 85)",
  blush: "oklch(0.75 0.12 15 / 45%)",
  crater: "oklch(0 0 0 / 13%)",
  land: "oklch(0.68 0.13 145)",
  cloud: "oklch(1 0 0 / 70%)",
  storm: "oklch(0.62 0.15 35)",
  darkSpot: "oklch(0.3 0.12 265 / 55%)",
  heart: "oklch(0.95 0.03 80)",
  sunGlow: "oklch(0.88 0.15 85 / 55%)",
  swirl: "oklch(1 0 0 / 30%)",
  ringSaturn: "oklch(0.8 0.06 80)",
  ringUranus: "oklch(0.85 0.04 200)",
  online: "oklch(0.72 0.17 150)",
  shadowSoft: "0 1px 2px oklch(0 0 0 / 4%), 0 8px 24px -12px oklch(0 0 0 / 12%)",
} as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: ColorTokens) {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

function renderSaturnTokens(): string {
  const planetVars = Object.entries(PLANET_GRADIENT_TOKENS).map(
    ([id, grad]) => `  --${id}: ${grad};`,
  );
  const accentVars = Object.entries(SATURN_ACCENT_TOKENS).map(
    ([key, val]) => `  --${key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`)}: ${val};`,
  );
  const planetClasses = PLANET_IDS.map(
    (id) => `.planet-${id} { background: var(--${id}); }`,
  );

  return `:root {
${accentVars.join("\n")}

${planetVars.join("\n")}
}

${planetClasses.join("\n")}

.saturn-ring { border-color: var(--ring-saturn); }
.border-ring-uranus { border-color: var(--ring-uranus); }
.bg-eye { background-color: var(--eye); }
.bg-pupil { background-color: var(--pupil); }
.bg-blush { background-color: var(--blush); }
.bg-crater { background-color: var(--crater); }
.bg-land { background-color: var(--land); }
.bg-cloud { background-color: var(--cloud); }
.bg-storm { background-color: var(--storm); }
.bg-dark-spot { background-color: var(--dark-spot); }
.bg-heart { background-color: var(--heart); }
.bg-sun-glow { background-color: var(--sun-glow); }
.bg-swirl { background-color: var(--swirl); }
.bg-online { background-color: var(--online); }
.shadow-soft { box-shadow: var(--shadow-soft); }

@keyframes saturn-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95% { transform: scaleY(0.1); }
}
@keyframes saturn-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
@keyframes saturn-fade-up {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes saturn-spin-slow {
  to { transform: rotate(360deg); }
}
@keyframes saturn-drift {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(8%); }
}

.animate-blink { animation: saturn-blink 4.5s infinite; transform-origin: center; }
.animate-float { animation: saturn-float 6s ease-in-out infinite; }
.animate-fade-up { animation: saturn-fade-up 0.35s ease-out both; }
.animate-spin-slow { animation: saturn-spin-slow 24s linear infinite; }
.animate-drift { animation: saturn-drift 7s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .animate-blink,
  .animate-float,
  .animate-fade-up,
  .animate-spin-slow,
  .animate-drift {
    animation: none !important;
  }
}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Modified for Saturn bot: Saturn UI and localization adaptations from the recorded upstream snapshot. See PROVENANCE.md. */",
    "/* Generated by `pnpm --filter @rakazo/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    renderSaturnTokens(),
  ].join("\n\n")}\n`;
}
