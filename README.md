# Saturn bot

**Your AI team. Your models. Your workspace.**

An open-source workspace for AI teammates, with configurable model connections and a planet-inspired interface.

- Bring your own supported provider credentials and choose the model that fits the job.
- Keep bots, conversations, files and computer-assisted work in one application stack.
- Give each bot a planet identity, with twelve visual choices and English/Thai adaptations.
- Run the application on infrastructure you control; external model and tool calls still follow their providers' policies and billing.

## Source toolchain

Source checks use Node.js 22.23.0 (recorded in `.nvmrc`) and pnpm 9.15.0. The Node engine range reflects the locked development dependencies; Node 20 and Node 22 versions below 22.22.2 cannot run all source checks. This does not qualify a native installer or a running stack.

## Development status

This is a development source snapshot. The isolated web build, web/shared UI typechecks, desktop compile and 22 affected authentication/locale tests pass. No stable release, whole-project acceptance, or head-to-head performance/cost advantage is claimed. Advanced Thai copy can retain English fallback. New-theme visual review, native packaging and end-to-end backend operation need their own validation. See [validation boundaries](docs/VALIDATION_STATUS.md).

## Learn more

- [Local Computer setup and limits](docs/LOCAL_COMPUTER.md)
- [Project overview in Thai](docs/PRODUCT_OVERVIEW_TH.md)
- [Comparison and cost claims](docs/COMPARISON_AND_COST.md)
- [Brand palette](docs/BRAND.md)
- [Presentation design prompt](docs/LOVABLE_PRESENTATION_PROMPT_TH.md)

Built on [Rakazo](https://github.com/elie222/rakazo). See [provenance](PROVENANCE.md), [NOTICE](NOTICE), and [LICENSE](LICENSE).
