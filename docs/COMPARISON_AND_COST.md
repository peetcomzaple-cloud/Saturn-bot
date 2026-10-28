# Positioning and cost claims

Research checked 2026-10-27. This is a feature-positioning note, not a head-to-head benchmark or a claim that Saturn is universally better.

| Reference | Saturn positioning | Important limit |
| --- | --- | --- |
| Hosted ChatGPT chat application | A separately deployable application stack with configurable provider/model connections and owned runtime choices | Compare the hosted chat app, not the entire OpenAI API/agent ecosystem. Quality and total cost have not been compared. |
| Hosted Claude chat application | Provider choice and self-managed application/runtime rather than relying on one hosted chat product | Claude's developer/API and agent products are separate comparisons. Do not claim they cannot support automation or API credentials. |
| OpenClaw | Saturn's particular planet identity, bot-centered application UI and localized presentation | BYO credentials and caching are not unique: OpenClaw documents both. No measured cost, reliability or usability superiority established. |
| Rakazo | Saturn branding, visual/locale adaptations and the recorded fork's code changes | Self-hosting, provider interfaces and much of the agent infrastructure are inherited foundations; do not claim them as uniquely invented by Saturn. |

OpenAI documents separate ChatGPT and API billing. Anthropic also distinguishes its chat plans and Console/API products; plan-specific credits can exist. BYO keys do not by themselves make API usage free or guarantee a lower bill. Sources: [OpenAI billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform), [Claude billing](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan).

OpenClaw documents provider API-key/OAuth support and cache controls. Sources: [authentication](https://docs.openclaw.ai/gateway/authentication), [prompt caching](https://docs.openclaw.ai/reference/prompt-caching).

## What Saturn's source supports saying

- Configurable provider/model choice and model capability checks are present.
- Context-budget and tool-result handling are present. The context estimator is a conservative byte-based estimate, not an exact tokenizer or a measurement of provider charges.
- Cache-retention requests are capability-dependent. They cannot promise a provider cache hit or a specific billed discount.
- Price metadata can support model ordering; missing prices must not be treated as free. Input/output weighting is a heuristic, not proof of globally optimal routing.

Source references: `packages/adapters/src/context-selection.ts`, `pi-cache-retention.ts`, `pi-usage.ts`, `model-price-order.ts`, `model-selection.ts`, and `packages/core/src/model-providers.ts`.

## Measuring future savings fairly

Use the same task set, quality gates, model/provider versions, tool permissions and runtime limits. Record successful/failed/blocked tasks; actual provider input/output/cache tokens; retries and tool calls; elapsed time; and billed model/tool/infra cost. Compare cost per successfully completed task, not just tokens per prompt. Report cold/warm cache separately. Do not run this benchmark without its own authorized prerequisites.

Until then, approved copy is “designed to give you control over model and context costs,” not “saves X%,” “faster than ChatGPT,” or “more reliable than OpenClaw.”
