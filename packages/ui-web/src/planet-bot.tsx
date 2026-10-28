import { useEffect, useState } from "react";
import { cn } from "./lib/utils.js";

export type PlanetId =
  | "sun"
  | "mercury"
  | "venus"
  | "earth"
  | "mars"
  | "jupiter"
  | "saturn"
  | "uranus"
  | "neptune"
  | "moon"
  | "pluto"
  | "ceres";

export interface PlanetDef {
  id: PlanetId;
  name: string;
  th: string;
  vibe: string;
  vibeEn: string;
  color: string;
}

export const PLANETS: PlanetDef[] = [
  { id: "saturn", name: "Saturn", th: "ดาวเสาร์", vibe: "ใจเย็น รอบคอบ", vibeEn: "Calm & thoughtful", color: "#E0B86C" },
  { id: "sun", name: "Sun", th: "ดวงอาทิตย์", vibe: "สดใส พลังเยอะ", vibeEn: "Bright & energetic", color: "#F59E0B" },
  { id: "mercury", name: "Mercury", th: "ดาวพุธ", vibe: "ตอบไว กระชับ", vibeEn: "Quick & concise", color: "#94A3B8" },
  { id: "venus", name: "Venus", th: "ดาวศุกร์", vibe: "อ่อนโยน สร้างสรรค์", vibeEn: "Gentle & creative", color: "#F472B6" },
  { id: "earth", name: "Earth", th: "โลก", vibe: "เป็นกันเอง", vibeEn: "Friendly", color: "#3B82F6" },
  { id: "mars", name: "Mars", th: "ดาวอังคาร", vibe: "ตรงไปตรงมา", vibeEn: "Straight-talking", color: "#EF4444" },
  { id: "jupiter", name: "Jupiter", th: "ดาวพฤหัสบดี", vibe: "รอบรู้ ลึกซึ้ง", vibeEn: "Wise & deep", color: "#D97706" },
  { id: "uranus", name: "Uranus", th: "ดาวยูเรนัส", vibe: "คิดนอกกรอบ", vibeEn: "Out-of-the-box", color: "#06B6D4" },
  { id: "neptune", name: "Neptune", th: "ดาวเนปจูน", vibe: "ช่างฝัน", vibeEn: "Dreamy", color: "#6366F1" },
  { id: "moon", name: "Moon", th: "ดวงจันทร์", vibe: "สงบ ฟังเก่ง", vibeEn: "Calm listener", color: "#CBD5E1" },
  { id: "pluto", name: "Pluto", th: "ดาวพลูโต", vibe: "ขี้เล่น น่ารัก", vibeEn: "Playful & cute", color: "#A855F7" },
  { id: "ceres", name: "Ceres", th: "ดาวซีรีส", vibe: "เรียบง่าย ช่างสังเกต", vibeEn: "Simple & observant", color: "#78716C" },
];

export function isPlanetId(value: string | null | undefined): value is PlanetId {
  if (!value) return false;
  return PLANETS.some((p) => p.id === value);
}

export function deterministicPlanetId(identity: string): PlanetId {
  if (!identity) return "saturn";
  const lower = identity.trim().toLowerCase();
  if (isPlanetId(lower)) return lower;
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) >>> 0;
  }
  const index = Math.abs(hash) % PLANETS.length;
  const match = PLANETS[index];
  return match ? match.id : "saturn";
}

const planetClass: Record<PlanetId, string> = {
  sun: "planet-sun",
  mercury: "planet-mercury",
  venus: "planet-venus",
  earth: "planet-earth",
  mars: "planet-mars",
  jupiter: "planet-jupiter",
  saturn: "planet-saturn",
  uranus: "planet-uranus",
  neptune: "planet-neptune",
  moon: "planet-moon",
  pluto: "planet-pluto",
  ceres: "planet-ceres",
};

export interface PlanetBotProps {
  planet: PlanetId;
  size?: number;
  thinking?: boolean;
  className?: string;
}

/** Minimal planet face: only two eyes that glance around smoothly. */
export function PlanetBot({
  planet,
  size = 40,
  thinking = false,
  className,
}: PlanetBotProps) {
  const [look, setLook] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const mediaQuery =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    if (mediaQuery?.matches) {
      setLook({ x: 0, y: 0 });
      return;
    }

    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      if (mediaQuery?.matches) {
        setLook({ x: 0, y: 0 });
        return;
      }
      const r = Math.random();
      setLook(
        r < 0.35
          ? { x: 0, y: 0 }
          : { x: Math.random() * 2 - 1, y: (Math.random() * 2 - 1) * 0.6 },
      );
      t = setTimeout(
        step,
        (thinking ? 600 : 1800) + Math.random() * (thinking ? 500 : 1800),
      );
    };
    t = setTimeout(step, 500 + Math.random() * 1000);
    return () => clearTimeout(t);
  }, [thinking]);

  const shift = size * 0.09;
  return (
    <div
      className={cn("rakazo-bot-avatar relative shrink-0 select-none", className)}
      style={{ width: size, height: size }}
      data-planet={planet}
      data-working={thinking}
    >
      {thinking && (
        <svg
          className="rakazo-bot-avatar-ring absolute pointer-events-none text-primary"
          style={{ inset: -4, width: size + 8, height: size + 8 }}
          viewBox="0 0 48 48"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="24"
            cy="24"
            r="22"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeDasharray="45 80"
          />
        </svg>
      )}
      {planet === "saturn" && (
        <div
          className="saturn-ring pointer-events-none absolute left-1/2 top-1/2 rounded-[50%] border-2"
          style={{
            width: size * 1.55,
            height: size * 0.42,
            transform: "translate(-50%,-50%) rotate(-14deg)",
          }}
        />
      )}
      {planet === "sun" && (
        <div className="absolute animate-spin-slow pointer-events-none" style={{ inset: -size * 0.14 }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="absolute left-1/2 top-0 rounded-full bg-sun-glow"
              style={{
                width: size * 0.07,
                height: size * 0.16,
                marginLeft: -size * 0.035,
                transformOrigin: `50% ${size * 0.64}px`,
                transform: `rotate(${i * 30}deg)`,
              }}
            />
          ))}
        </div>
      )}
      {planet === "uranus" && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 rounded-[50%] border-2 border-ring-uranus"
          style={{
            width: size * 0.38,
            height: size * 1.45,
            transform: "translate(-50%,-50%) rotate(12deg)",
          }}
        />
      )}
      <div
        className={cn(
          "absolute inset-0 overflow-hidden rounded-full shadow-soft",
          planetClass[planet],
        )}
      >
        <Surface planet={planet} size={size} />
      </div>
      <div
        className="absolute inset-0 flex items-center justify-center transition-transform duration-700 ease-[cubic-bezier(.22,1,.36,1)] pointer-events-none"
        style={{
          gap: size * 0.16,
          transform: `translate(${look.x * shift}px, ${look.y * shift}px)`,
        }}
      >
        {[0, 1].map((i) => (
          <div key={i} className="relative flex flex-col items-center">
            <div
              className="relative rounded-full bg-pupil animate-blink"
              style={{ width: size * 0.13, height: size * 0.15 }}
            >
              <div
                className="absolute rounded-full bg-eye"
                style={{
                  width: size * 0.045,
                  height: size * 0.045,
                  top: "18%",
                  left: "22%",
                }}
              />
            </div>
            <div
              className="absolute rounded-full bg-blush"
              style={{
                width: size * 0.12,
                height: size * 0.06,
                top: size * 0.17,
                [i ? "left" : "right"]: -size * 0.04,
              }}
            />
          </div>
        ))}
      </div>
      {planet === "saturn" && (
        <div
          className="saturn-ring pointer-events-none absolute left-1/2 top-1/2 rounded-[50%] border-2 border-t-transparent"
          style={{
            width: size * 1.55,
            height: size * 0.42,
            transform: "translate(-50%,-50%) rotate(-14deg)",
            clipPath: "inset(50% 0 0 0)",
          }}
        />
      )}
    </div>
  );
}

function Dot({
  x,
  y,
  w,
  h = w,
  className,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  className: string;
}) {
  return (
    <div
      className={cn("absolute rounded-full", className)}
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: `${w}%`,
        height: `${h}%`,
      }}
    />
  );
}

/** Per-world surface details so each bot has its own character. */
function Surface({ planet }: { planet: PlanetId; size?: number }) {
  switch (planet) {
    case "mercury":
    case "ceres":
    case "moon":
      return (
        <>
          <Dot x={18} y={14} w={16} className="bg-crater" />
          <Dot x={66} y={22} w={10} className="bg-crater" />
          <Dot x={60} y={70} w={20} className="bg-crater" />
          <Dot x={22} y={72} w={9} className="bg-crater" />
          {planet === "ceres" && <Dot x={44} y={18} w={7} className="bg-eye" />}
        </>
      );
    case "venus":
      return (
        <>
          <Dot x={-10} y={12} w={80} h={14} className="bg-swirl animate-drift" />
          <Dot x={30} y={74} w={80} h={12} className="bg-swirl animate-drift" />
        </>
      );
    case "earth":
      return (
        <>
          <Dot x={8} y={12} w={34} h={24} className="bg-land" />
          <Dot x={62} y={60} w={32} h={30} className="bg-land" />
          <Dot x={14} y={70} w={18} h={12} className="bg-land" />
          <Dot x={40} y={4} w={40} h={10} className="bg-cloud animate-drift" />
          <Dot x={4} y={86} w={46} h={9} className="bg-cloud animate-drift" />
        </>
      );
    case "mars":
      return (
        <>
          <Dot x={34} y={-4} w={32} h={14} className="bg-heart" />
          <Dot x={16} y={68} w={14} className="bg-crater" />
          <Dot x={68} y={20} w={10} className="bg-crater" />
        </>
      );
    case "jupiter":
      return <Dot x={58} y={64} w={22} h={13} className="bg-storm" />;
    case "neptune":
      return (
        <>
          <Dot x={20} y={66} w={22} h={13} className="bg-dark-spot" />
          <Dot x={-5} y={18} w={60} h={6} className="bg-swirl animate-drift" />
        </>
      );
    case "pluto":
      return (
        <div
          className="absolute"
          style={{
            left: "52%",
            top: "58%",
            width: "34%",
            height: "30%",
          }}
        >
          <Dot x={0} y={0} w={55} h={65} className="bg-heart" />
          <Dot x={45} y={0} w={55} h={65} className="bg-heart" />
          <div
            className="absolute bg-heart"
            style={{
              left: "17%",
              top: "30%",
              width: "66%",
              height: "66%",
              transform: "rotate(45deg)",
              borderRadius: "2px",
            }}
          />
        </div>
      );
    case "saturn":
      return (
        <>
          <Dot x={-10} y={24} w={120} h={7} className="bg-swirl" />
          <Dot x={-10} y={76} w={120} h={6} className="bg-swirl" />
        </>
      );
    default:
      return null;
  }
}
