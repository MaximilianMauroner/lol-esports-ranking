# Repository Instructions

- Pre 1.0 breaking changes are encouraged when they improve the quality of the codebase or the accuracy of the data.
- Keep ranking claims tied to the data source and model version that produced them.
- Do not present seeded or sample data as official LoL Esports data.
- Use shadcn/ui components from `src/components/ui` wherever they make sense for the UI surface, including dashboard controls and Recharts-backed dashboard charts. Build custom components only when shadcn does not fit the interaction or data-density need.
- The goal is for the score to be as accurate as possible, so if you have a better way to do something, please suggest it.
- Another goal is to have a score for leagues that is accurate and fair
- Not all games should be scored equally - some leagues are more competitive than others, and the scoring should reflect that. And tournaments should be scored more than regular season games.
- Before starting the dev server check if one is already running. If so, use that one instead of starting a new one.
