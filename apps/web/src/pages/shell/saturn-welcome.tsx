import type { PlanetId } from "@rakazo/ui-web";
import { BotAvatar, cn, PLANETS } from "@rakazo/ui-web";
import { useLingui } from "@lingui/react/macro";
import { memo } from "react";

export interface SaturnWelcomeHeroProps {
  botId?: string;
  botColor?: string;
  botName?: string;
  planetId?: PlanetId;
  onSendPrompt?: (prompt: string) => void;
  disabled?: boolean;
}

export const SaturnWelcomeHero = memo(function SaturnWelcomeHero({
  botId,
  botColor,
  botName,
  planetId,
  onSendPrompt,
  disabled = false,
}: SaturnWelcomeHeroProps) {
  const { i18n } = useLingui();
  const isThai = (i18n.locale || "").startsWith("th");

  const suggestions = isThai
    ? [
        { label: "สรุปข้อมูลด่วน 📝", prompt: "ช่วยสรุปประเด็นสำคัญให้หน่อย" },
        {
          label: "ช่วยคิดไอเดียสร้างสรรค์ 💡",
          prompt: "ช่วยระดมความคิดสร้างสรรค์สำหรับโปรเจกต์นี้หน่อย",
        },
        { label: "เขียนโค้ดและดีบัก 💻", prompt: "ช่วยเขียนโค้ดและตรวจสอบข้อผิดพลาดหน่อย" },
        {
          label: "วางแผนงานและจัดลำดับ 🎯",
          prompt: "ช่วยจัดลำดับความสำคัญและวางแผนขั้นตอนการทำงานหน่อย",
        },
      ]
    : [
        { label: "Quick summary 📝", prompt: "Please summarize the key points." },
        {
          label: "Creative brainstorming 💡",
          prompt: "Help me brainstorm creative ideas for this project.",
        },
        { label: "Write & debug code 💻", prompt: "Help me write and debug some code." },
        { label: "Plan & prioritize 🎯", prompt: "Help me prioritize and create an action plan." },
      ];

  const isDisabled = disabled || !onSendPrompt;

  return (
    <div className="flex flex-1 flex-col items-center justify-center py-12 px-4 text-center select-none animate-fade-up">
      <div className="mb-5 flex items-center justify-center animate-float">
        <BotAvatar
          color={
            botColor ??
            (planetId ? PLANETS.find((p) => p.id === planetId)?.color ?? "#E0B86C" : "#E0B86C")
          }
          identity={botId ?? botName ?? ""}
          planet={planetId}
          size={72}
        />
      </div>
      <h3 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
        {isThai
          ? botName
            ? `สวัสดี! ฉันคือ ${botName}`
            : "ยินดีต้อนรับสู่ Saturn"
          : botName
            ? `Hello! I'm ${botName}`
            : "Welcome to Saturn"}
      </h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {isThai
          ? "พร้อมร่วมงานและค้นหาคำตอบไปด้วยกัน เลือกหัวข้อแนะนำหรือเริ่มพิมพ์ได้เลย"
          : "Ready to explore and build together. Choose a quick topic or start typing below."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-md">
        {suggestions.map((item, idx) => (
          <button
            key={idx}
            type="button"
            disabled={isDisabled}
            onClick={() => {
              if (isDisabled) return;
              onSendPrompt(item.prompt);
            }}
            className={cn(
              "rounded-full border border-border/80 bg-card/80 backdrop-blur-xs px-3.5 py-1.5 text-xs font-medium shadow-2xs transition-all",
              isDisabled
                ? "opacity-50 cursor-not-allowed text-muted-foreground"
                : "text-foreground/80 hover:bg-accent hover:text-foreground hover:scale-105 active:scale-95",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
});
