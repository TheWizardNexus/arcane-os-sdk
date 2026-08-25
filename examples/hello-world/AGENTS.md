# Arcane Hello World development instructions

- Use plain JavaScript, HTML, and CSS; do not introduce TypeScript or TSX.
- Keep reusable mechanisms in Arcane OS and app-specific behavior under `apps/hello-world/`.
- Keep `arcane/css/theme.css` before app styles and import `arcane/ThemeBootstrap` before app code runs.
- Use `rgb(...)` or `rgba(...)` for new CSS colors.
- Build one named app and one explicit target at a time.
- Do not run `npm run check` or any other test or check before committing unless
  the user explicitly requests it or the selected work builds, verifies, or
  releases a `dist`, package, artifact, or other release output.
