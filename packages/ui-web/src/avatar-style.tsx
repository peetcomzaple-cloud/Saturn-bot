/* Modified for Saturn bot: Saturn UI and localization adaptations from the recorded upstream snapshot. See PROVENANCE.md. */
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export type AvatarStyle = "robot" | "organic" | "planet";

const AvatarStyleContext = createContext<AvatarStyle>("robot");

export function AvatarStyleProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: AvatarStyle;
}) {
  return <AvatarStyleContext value={value}>{children}</AvatarStyleContext>;
}

export function useAvatarStyle(): AvatarStyle {
  return useContext(AvatarStyleContext);
}
