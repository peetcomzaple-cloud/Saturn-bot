/* Modified for Saturn bot: component-only visual fixture; obsolete strip removed. See PROVENANCE.md. */
import { I18nProvider } from "@lingui/react";
import type { Bot } from "@rakazo/contracts";
import {
  AvatarStyleProvider,
  BotAvatar,
  cn,
  deterministicPlanetId,
  PLANETS,
  PlanetBot,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { activateUiLocale, bootstrapI18n, i18n } from "../../src/lib/i18n";
import { SaturnWelcomeHero } from "../../src/pages/shell/saturn-welcome";
import "../../src/styles.css";

const sampleBots: Bot[] = [
  {
    id: "bot-saturn-01",
    spaceId: "space-demo",
    name: "Saturn Assistant",
    title: "Lead Orbiting Companion",
    description: "Helps analyze, plan, and build projects thoughtfully.",
    disabledBuiltinTools: [],
    instructions: "Be calm, clear, and structured.",
    color: "#E2B16B",
    notifyOnFinish: true,
    pinned: true,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-saturn",
    preview: "Hello! How can I help you today?",
    status: "idle",
    computerMode: "team",
    updatedAt: "2026-10-27T00:00:00.000Z",
    createdAt: "2026-10-27T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: "google",
    modelId: "gemini-3.8-flash",
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
  },
  {
    id: "bot-mercury-02",
    spaceId: "space-demo",
    name: "Mercury",
    title: "Fast Responder",
    description: "Quick summary and speed answering.",
    disabledBuiltinTools: [],
    instructions: "Respond rapidly and concisely.",
    color: "#94A3B8",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-mercury",
    preview: "Ready for quick questions!",
    status: "busy",
    computerMode: "team",
    updatedAt: "2026-10-27T00:00:00.000Z",
    createdAt: "2026-10-27T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: "google",
    modelId: "gemini-3.8-flash",
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
  },
  {
    id: "bot-mars-03",
    spaceId: "space-demo",
    name: "Mars Code",
    title: "Direct Code Builder",
    description: "Straightforward code execution and testing.",
    disabledBuiltinTools: [],
    instructions: "No fluff, straight code.",
    color: "#EF4444",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-mars",
    preview: "Let's debug this issue directly.",
    status: "idle",
    computerMode: "team",
    updatedAt: "2026-10-27T00:00:00.000Z",
    createdAt: "2026-10-27T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: "google",
    modelId: "gemini-3.8-flash",
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
  },
];

function SaturnVisualHarness() {
  const [locale, setLocale] = useState("en");
  const [activeBotId, setActiveBotId] = useState<string>("bot-saturn-01");
  const [messages, setMessages] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"empty" | "chat">("empty");
  const isThai = locale.startsWith("th");

  useEffect(() => {
    void bootstrapI18n("en").then(() => setLocale(i18n.locale || "en"));
  }, []);

  const switchLocale = async (newLoc: "en" | "th") => {
    await activateUiLocale(newLoc);
    setLocale(newLoc);
  };

  const activeBot = sampleBots.find((b) => b.id === activeBotId) ?? sampleBots[0]!;
  const planetId = deterministicPlanetId(activeBot.id || activeBot.name);

  return (
    <I18nProvider i18n={i18n}>
      <AvatarStyleProvider value="planet">
        <div className="flex min-h-screen flex-col bg-background text-foreground">
          {/* Top Test Controller Bar */}
          <header className="flex items-center justify-between border-b border-border bg-card/60 px-6 py-3 backdrop-blur-xs">
            <div className="flex items-center gap-3">
              <img
                src="/saturn-logo.png"
                alt="Saturn Logo"
                className="h-8 w-8 rounded-full shadow-xs object-cover"
              />
              <div>
                <h1 className="text-base font-semibold leading-tight">
                  Saturn UI Visual Test Harness
                </h1>
                <p className="text-xs text-muted-foreground">
                  Fixture-backed isolated inspection (Fail-Closed, zero live API dependency)
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* View Toggle */}
              <div className="flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setViewMode("empty")}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    viewMode === "empty"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Empty Hero
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("chat");
                    if (messages.length === 0) {
                      setMessages(["Can you review our project status?"]);
                    }
                  }}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    viewMode === "chat"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Chat View
                </button>
              </div>

              {/* Bilingual EN / ไทย Switcher */}
              <div className="flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => void switchLocale("en")}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    locale.startsWith("en")
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  English
                </button>
                <button
                  type="button"
                  onClick={() => void switchLocale("th")}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    locale.startsWith("th")
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  ไทย
                </button>
              </div>
            </div>
          </header>

          {/* Main Layout Preview */}
          <div className="flex flex-1 overflow-hidden">
            {/* Sidebar Preview */}
            <aside className="w-72 shrink-0 border-r border-border bg-sidebar p-3 flex flex-col gap-3">
              <div className="flex items-center justify-between px-2 pt-1">
                <div className="flex items-center gap-2">
                  <img
                    src="/saturn-logo.png"
                    alt="Saturn"
                    className="h-6 w-6 rounded-full object-cover"
                  />
                  <span className="font-semibold text-sm">Saturn</span>
                </div>
                <span className="text-xs text-muted-foreground">v0.1.0</span>
              </div>

              {/* Bot Roster */}
              <div className="flex flex-col gap-1 mt-2">
                <span className="px-2 text-[11px] font-medium uppercase text-muted-foreground/80">
                  {isThai ? "รายชื่อบอท" : "Bot Roster"}
                </span>
                {sampleBots.map((bot) => {
                  const isSelected = bot.id === activeBotId;
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => setActiveBotId(bot.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                        isSelected
                          ? "bg-accent text-accent-foreground font-medium shadow-xs"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                    >
                      <BotAvatar color={bot.color} identity={bot.id} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {bot.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{bot.title}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* Chat Content Area */}
            <main className="flex flex-1 flex-col overflow-hidden bg-background">
              {/* Header Bar */}
              <div className="flex items-center justify-between border-b border-border px-6 py-3.5">
                <div className="flex items-center gap-3">
                  <BotAvatar
                    color={activeBot.color}
                    identity={activeBot.id}
                    size={32}
                    status={activeBot.status}
                  />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{activeBot.name}</h2>
                    <p className="text-xs text-muted-foreground">{activeBot.title}</p>
                  </div>
                </div>

                {/* Minimal Header Controls (No phone/video per owner) */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {isThai ? "สถานะ: พร้อมใช้งาน" : "Status: Active"}
                  </span>
                </div>
              </div>

              {/* Transcript / Empty Area */}
              <div className="flex flex-1 flex-col overflow-y-auto p-6">
                {viewMode === "empty" ? (
                  <SaturnWelcomeHero
                    planetId={planetId}
                    botName={activeBot.name}
                    onSendPrompt={(p) => {
                      setMessages([p]);
                      setViewMode("chat");
                    }}
                  />
                ) : (
                  <div className="flex flex-col gap-4 max-w-2xl mx-auto w-full py-4">
                    {messages.map((msg, i) => (
                      <div key={i} className="flex justify-end">
                        <div className="rounded-2xl bg-chat-user px-4 py-2.5 text-sm text-chat-user-foreground shadow-xs">
                          {msg}
                        </div>
                      </div>
                    ))}
                    <div className="flex items-start gap-3">
                      <BotAvatar color={activeBot.color} identity={activeBot.id} size={36} />
                      <div className="rounded-2xl bg-card border border-border px-4 py-3 text-sm text-foreground shadow-xs">
                        {isThai
                          ? `สวัสดีครับ! ผมคือ ${activeBot.name} พร้อมช่วยวางแผนและจัดการงานตามคำขอของคุณแล้วครับ`
                          : `Hello! I'm ${activeBot.name}, ready to assist you with thoughtful analysis and execution.`}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="border-t border-border p-4 bg-card/40">
                <div className="flex items-center gap-2 max-w-3xl mx-auto rounded-2xl border border-border bg-background px-4 py-2.5 shadow-xs">
                  <input
                    type="text"
                    placeholder={isThai ? "พิมพ์ข้อความที่ต้องการ…" : "Type a message…"}
                    className="flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.currentTarget.value.trim()) {
                        setMessages((prev) => [...prev, e.currentTarget.value.trim()]);
                        setViewMode("chat");
                        e.currentTarget.value = "";
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="rounded-xl bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-xs transition hover:opacity-90"
                  >
                    {isThai ? "ส่ง" : "Send"}
                  </button>
                </div>
              </div>
            </main>
          </div>

          {/* 12 Planets Showcase Footer */}
          <footer className="border-t border-border bg-card/80 p-4">
            <div className="max-w-5xl mx-auto">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {isThai ? "ระบบดาวเคราะห์ 12 ดวง (Saturn Companions)" : "12-Planet Design System Showcase"}
                </h3>
                <span className="text-xs text-muted-foreground">
                  All 12 animated with glance + reduced-motion support
                </span>
              </div>
              <div className="grid grid-cols-6 sm:grid-cols-12 gap-2 text-center">
                {PLANETS.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-col items-center gap-1 rounded-xl border border-border/60 bg-background/50 p-2 shadow-2xs"
                  >
                    <PlanetBot planet={p.id} size={36} />
                    <span className="text-[11px] font-semibold text-foreground truncate w-full">
                      {isThai ? p.th : p.name}
                    </span>
                    <span className="text-[9px] text-muted-foreground truncate w-full">
                      {isThai ? p.vibe : p.vibeEn}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </footer>
        </div>
      </AvatarStyleProvider>
    </I18nProvider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<SaturnVisualHarness />);
}
