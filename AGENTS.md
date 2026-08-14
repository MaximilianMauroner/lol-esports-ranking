# Agent instructions

## Ranking model

- Tie every ranking claim to the data source, model configuration, schema, and
  coverage window that produced it.
- Never present seeded or sample data as official LoL Esports data.
- Score match impact by competition level and match type. Tournament matches
  should weigh more than regular-season matches. Document and test any change
  to this rule.
- Prefer a fair, explainable score over a complex model with unclear effects.
  Propose a better method when the evidence supports it.

## Development

- The model is pre-1.0. Breaking changes are allowed when they improve data
  accuracy or remove a weak design.
- Use components from `src/components/ui` when they fit the interaction and
  data density. Build a custom component only when the existing set does not
  fit.
- Check for a running development server before you start another one.
- Run focused model and provenance tests for ranking changes.
