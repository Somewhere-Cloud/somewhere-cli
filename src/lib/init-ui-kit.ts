import type { InitScaffoldFile } from './init-scaffold.js';
// The auth starter's UI kit (src/ui) and, for --ui styled, its stylesheets.
// Each view exists in both modes with the same exports and props: the styled
// one renders the classes app.css styles, the headless one semantic markup.
// Views take props only; they import react, a sibling, ../routes or types.

// ------------------------------------------------------------------ styles

export const TOKENS_CSS = `/* Design tokens: the only place colours, type and spacing are defined.
   app.css and src/ui read these; pages never write a raw hex or px value.
   To restyle the whole app, change the values here.

   Fonts are local stacks only (no network fonts), chosen so every platform
   falls back to a good face, not to Arial/Times. Prefer one family: set
   --font-display to a serif stack only if the app wants that personality. */
:root {
  color-scheme: light;

  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-display: var(--font-body);
  /* Serif alternative: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; */
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.375rem;
  --text-2xl: 1.75rem;
  --text-display: clamp(2rem, 4.4vw, 2.75rem);
  --tracking-display: -0.02em;
  --tracking-label: 0.06em;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  --radius-control: 8px;
  --radius-panel: 14px;
  --radius-pill: 999px;

  --control-height: 44px;
  --content-width: 1040px;

  --shadow-sm: 0 1px 2px rgba(28, 27, 24, 0.05);
  --shadow-md: 0 1px 2px rgba(28, 27, 24, 0.05), 0 16px 40px -28px rgba(28, 27, 24, 0.35);
  --shadow-lg: 0 24px 64px -24px rgba(28, 27, 24, 0.45);

  /* Surfaces and text */
  --color-bg: #f5f3ee;
  --color-surface: #ffffff;
  --color-surface-2: #faf8f4;
  --color-text: #1c1b18;
  --color-muted: #66615a;
  --color-border: #e0dbd1;
  --color-border-strong: #c9c2b5;

  /* One accent. Everything interactive uses it. */
  --color-accent: #1d6b52;
  --color-accent-hover: #185b46;
  --color-accent-soft: #e3efe9;
  --color-on-accent: #ffffff;
  --color-focus: #1d6b52;

  /* Semantic tones for badges, notices and stats: not for buttons. */
  --color-success: #1d6b52;
  --color-success-soft: #e3efe9;
  --color-warning: #8a5a00;
  --color-warning-soft: #f7ebd2;
  --color-danger: #b42318;
  --color-danger-soft: #fbe4e1;
  --color-info: #2a5d9f;
  --color-info-soft: #e1eaf7;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 1px 2px rgba(0, 0, 0, 0.3), 0 16px 40px -28px rgba(0, 0, 0, 0.7);
    --shadow-lg: 0 24px 64px -24px rgba(0, 0, 0, 0.8);

    --color-bg: #15161a;
    --color-surface: #1e2025;
    --color-surface-2: #24272d;
    --color-text: #ecebe6;
    --color-muted: #a19d95;
    --color-border: #31343b;
    --color-border-strong: #454953;

    --color-accent: #5fbf9a;
    --color-accent-hover: #74cba9;
    --color-accent-soft: #1f3a31;
    --color-on-accent: #0f1f19;
    --color-focus: #5fbf9a;

    --color-success: #5fbf9a;
    --color-success-soft: #1f3a31;
    --color-warning: #e2b25a;
    --color-warning-soft: #3a2f16;
    --color-danger: #f0867c;
    --color-danger-soft: #42221f;
    --color-info: #7fa9e6;
    --color-info-soft: #1f2d42;
  }
}
`;

export const APP_CSS = `/* Base styles and the classes src/ui components render. Values come from
   tokens.css. Add app-specific styles at the end of this file, or in a new
   file imported from src/main.tsx; do not restyle native elements globally. */

/* ---------- Base ---------- */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font: 400 var(--text-base)/1.55 var(--font-body);
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { font-family: var(--font-display); line-height: 1.2; letter-spacing: var(--tracking-display); font-weight: 600; }
h1 { font-size: var(--text-2xl); }
h2 { font-size: var(--text-xl); }
h3 { font-size: var(--text-lg); }
a { color: var(--color-accent); text-underline-offset: 3px; }
code, kbd { font-family: var(--font-mono); font-size: 0.9em; }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
::placeholder { color: var(--color-muted); opacity: 0.8; }

.muted { color: var(--color-muted); }
.hint { margin: 0; color: var(--color-muted); font-size: var(--text-sm); font-weight: 400; }
.error { margin: 0; color: var(--color-danger); font-size: var(--text-sm); }
.skip-link { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; position: absolute; left: var(--space-3); top: -60px; padding: var(--space-2) var(--space-3); background: var(--color-text); color: var(--color-bg); z-index: 10; }
.skip-link:focus { top: var(--space-3); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- Layout primitives (src/ui/layout.tsx) ---------- */
.stack { display: grid; gap: var(--stack-gap, var(--space-4)); align-content: start; }
.stack > *, .grid > *, .card > *, .content > * { min-width: 0; }
.inline { display: flex; flex-wrap: wrap; gap: var(--inline-gap, var(--space-2)); align-items: var(--inline-align, center); justify-content: var(--inline-justify, flex-start); }
.grid { display: grid; gap: var(--grid-gap, var(--space-4)); grid-template-columns: repeat(auto-fit, minmax(min(var(--grid-min, 220px), 100%), 1fr)); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }

.page-header { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: flex-end; justify-content: space-between; margin-bottom: var(--space-8); }
.page-header__text { display: grid; gap: var(--space-1); min-width: 0; }
.page-header__title { font-size: var(--text-display); line-height: 1.1; }
.page-header__description { color: var(--color-muted); max-width: 60ch; }

.eyebrow { margin: 0; color: var(--color-muted); font-size: var(--text-xs); font-weight: 600; letter-spacing: var(--tracking-label); text-transform: uppercase; }
.section-title { margin: 0 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--color-muted); }

/* ---------- Panel and Card ---------- */
.panel {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}
.panel__title { margin: 0; font: 600 var(--text-lg)/1.2 var(--font-display); }

.card { display: grid; gap: 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-panel); background: var(--color-surface); box-shadow: var(--shadow-sm); overflow: hidden; }
.card__header { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); }
.card__heading { display: grid; gap: 2px; min-width: 0; }
.card__title { font-size: var(--text-base); font-weight: 600; letter-spacing: 0; }
.card__description { color: var(--color-muted); font-size: var(--text-sm); }
.card__body { padding: var(--space-5); }
.card__body--flush { padding: 0; }
.card__footer { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; padding: var(--space-3) var(--space-5); border-top: 1px solid var(--color-border); background: var(--color-surface-2); }

/* ---------- Buttons (src/ui/Button.tsx) ---------- */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: 0 var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-control);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.button:hover:not(:disabled) { background: var(--color-accent-hover); border-color: var(--color-accent-hover); }
.button:disabled { opacity: 0.5; cursor: not-allowed; }
.button--secondary { background: var(--color-surface); border-color: var(--color-border-strong); color: var(--color-text); }
.button--secondary:hover:not(:disabled) { background: var(--color-surface-2); border-color: var(--color-border-strong); }
.button--quiet { background: transparent; border-color: transparent; color: var(--color-text); }
.button--quiet:hover:not(:disabled) { background: var(--color-accent-soft); border-color: transparent; }
.button--danger { background: var(--color-danger); border-color: var(--color-danger); color: #fff; }
.button--danger:hover:not(:disabled) { background: var(--color-danger); border-color: var(--color-danger); filter: brightness(0.92); }
.button--sm { padding: 0 var(--space-3); font-size: var(--text-sm); }
.button--block { width: 100%; }
.button__spinner { width: 1em; height: 1em; border-width: 2px; }

.link-button {
  display: inline-flex; align-items: center; min-height: var(--control-height);
  padding: 0 var(--space-2); border: 0; background: none;
  color: var(--color-accent); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}
.link-button:disabled { opacity: 0.5; cursor: not-allowed; }
.link-button--danger { color: var(--color-danger); }

/* ---------- Fields (src/ui/Field.tsx) ---------- */
.field { display: grid; gap: 6px; min-width: 0; }
.field__label { display: flex; justify-content: space-between; gap: var(--space-2); font-size: var(--text-sm); font-weight: 600; }
.field__optional { color: var(--color-muted); font-weight: 400; }
.field .control {
  width: 100%;
  min-height: var(--control-height);
  padding: 10px 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-text);
}
.field .control:hover { border-color: var(--color-muted); }
.field .control[aria-invalid="true"] { border-color: var(--color-danger); }
.field .control:disabled { background: var(--color-surface-2); color: var(--color-muted); cursor: not-allowed; }
.field textarea.control { min-height: calc(var(--control-height) * 2.2); resize: vertical; line-height: 1.5; }
.field select.control {
  appearance: none;
  padding-right: 40px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%2366615a' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}
.field input[type="date"].control, .field input[type="time"].control { min-width: 10ch; }
.field--inline { grid-template-columns: auto 1fr; align-items: center; }
.field--inline .field__label { font-weight: 400; }
.field input[type="checkbox"], .field input[type="radio"] { width: 20px; height: 20px; margin: 0; accent-color: var(--color-accent); }
.field__hint { color: var(--color-muted); font-size: var(--text-sm); }
.field__error { color: var(--color-danger); font-size: var(--text-sm); }
.form-row { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(min(var(--form-row-min, 160px), 100%), 1fr)); align-items: start; }

/* ---------- Tabs (src/ui/Tabs.tsx) ---------- */
.tabs { display: flex; gap: var(--space-1); padding: var(--space-1); min-height: var(--control-height); border: 1px solid var(--color-border); border-radius: var(--radius-control); background: var(--color-surface-2); overflow-x: auto; scrollbar-width: none; max-width: 100%; }
.tabs::-webkit-scrollbar { display: none; }
.tab { flex: 0 0 auto; min-height: calc(var(--control-height) - 8px); padding: 0 var(--space-4); border: 0; border-radius: calc(var(--radius-control) - 2px); background: transparent; color: var(--color-muted); font-weight: 600; font-size: var(--text-sm); white-space: nowrap; cursor: pointer; }
.tab:hover { color: var(--color-text); }
.tab[aria-selected="true"] { background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-sm); }

/* ---------- Badge (src/ui/Badge.tsx) ---------- */
.badge { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 10px; border-radius: var(--radius-pill); background: var(--color-surface-2); border: 1px solid var(--color-border); color: var(--color-text); font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
.badge--accent { background: var(--color-accent-soft); border-color: transparent; color: var(--color-accent); }
.badge--success { background: var(--color-success-soft); border-color: transparent; color: var(--color-success); }
.badge--warning { background: var(--color-warning-soft); border-color: transparent; color: var(--color-warning); }
.badge--danger { background: var(--color-danger-soft); border-color: transparent; color: var(--color-danger); }
.badge--info { background: var(--color-info-soft); border-color: transparent; color: var(--color-info); }
.badge__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* ---------- Stat (src/ui/Stat.tsx) ---------- */
.stat { display: grid; gap: var(--space-2); padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-panel); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.stat__value { font-family: var(--font-display); font-size: var(--text-2xl); font-weight: 600; letter-spacing: var(--tracking-display); line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat__value small { color: var(--color-muted); font-size: 0.55em; font-weight: 500; letter-spacing: 0; margin-left: 0.3em; }
.stat__detail { color: var(--color-muted); font-size: var(--text-sm); }
.stat__detail--success { color: var(--color-success); }
.stat__detail--danger { color: var(--color-danger); }
.meter { height: 6px; border-radius: var(--radius-pill); background: var(--color-border); overflow: hidden; }
.meter__fill { height: 100%; border-radius: inherit; background: var(--color-accent); transition: width 240ms ease; }

/* ---------- Table (src/ui/Table.tsx) ---------- */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.table th, .table td { padding: var(--space-3) var(--space-5); text-align: left; vertical-align: middle; border-bottom: 1px solid var(--color-border); }
.table th { color: var(--color-muted); font-size: var(--text-xs); font-weight: 600; letter-spacing: var(--tracking-label); text-transform: uppercase; white-space: nowrap; background: var(--color-surface-2); }
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr:hover td { background: var(--color-surface-2); }
.table .is-numeric { text-align: right; }
.table__empty { padding: var(--space-8) var(--space-5); text-align: center; color: var(--color-muted); }

/* ---------- Notice (src/ui/Notice.tsx) ---------- */
.notice { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-border); border-left-width: 4px; border-radius: var(--radius-control); background: var(--color-surface); font-size: var(--text-sm); }
.notice__body { flex: 1 1 240px; display: grid; gap: 2px; min-width: 0; }
.notice__title { font-weight: 600; }
.notice--info { border-left-color: var(--color-info); }
.notice--success { border-left-color: var(--color-success); }
.notice--warning { border-left-color: var(--color-warning); }
.notice--danger { border-left-color: var(--color-danger); }
.notice__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }

/* Legacy alert from feedback.tsx; Notice is preferred for new code. */
.alert { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-danger); border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-surface); }
.alert p { margin: 0; }

/* ---------- Dialog (src/ui/Dialog.tsx) ---------- */
.dialog { width: min(480px, calc(100% - 2 * var(--space-4))); padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-panel); background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-lg); }
.dialog::backdrop { background: rgba(20, 20, 18, 0.45); backdrop-filter: blur(2px); }
.dialog__header { display: flex; align-items: start; justify-content: space-between; gap: var(--space-3); padding: var(--space-5) var(--space-5) 0; }
.dialog__title { font-size: var(--text-lg); }
.dialog__body { display: grid; gap: var(--space-4); padding: var(--space-4) var(--space-5) var(--space-5); }
.dialog__footer { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; padding: var(--space-3) var(--space-5); border-top: 1px solid var(--color-border); background: var(--color-surface-2); }

/* ---------- Skeleton (src/ui/Skeleton.tsx) ---------- */
.skeleton { display: grid; gap: var(--space-2); }
.skeleton__line { height: 1em; border-radius: 4px; background: linear-gradient(90deg, var(--color-border) 25%, var(--color-surface-2) 50%, var(--color-border) 75%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }

/* ---------- Empty state (src/ui/feedback.tsx) ---------- */
.empty { display: grid; gap: var(--space-2); justify-items: center; padding: var(--space-10) var(--space-6); border: 1px dashed var(--color-border-strong); border-radius: var(--radius-panel); text-align: center; }
.empty__title { margin: 0; font: 600 var(--text-lg)/1.3 var(--font-display); }
.empty__body { margin: 0; color: var(--color-muted); max-width: 44ch; }

/* ---------- Loading, unavailable, banner ---------- */
.loading { display: grid; place-content: center; justify-items: center; gap: var(--space-3); min-height: 100vh; color: var(--color-muted); }
.unavailable { max-width: 380px; margin: 0 var(--space-4); color: var(--color-text); }
.unavailable p { margin: 0; }
.banner { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: center; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-danger); background: var(--color-surface); color: var(--color-danger); }
.banner p { margin: 0; }
.spinner { width: 24px; height: 24px; border: 3px solid var(--color-border); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- Sign-in (src/ui/AuthCard.tsx) ---------- */
.auth {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 400px);
  gap: var(--space-12);
  align-items: center;
  width: min(960px, calc(100% - 2 * var(--space-6)));
  min-height: 100vh;
  margin: 0 auto;
  padding: var(--space-12) 0;
}
.auth__intro { display: grid; gap: var(--space-3); align-content: center; }
.auth__app { margin: 0; color: var(--color-accent); font-weight: 600; }
.auth__title { margin: 0; font-size: var(--text-display); line-height: 1.05; }
.auth__column { display: grid; gap: var(--space-4); }
.auth__form .button { width: 100%; }
.auth__providers { display: grid; gap: var(--space-2); }
.auth__switch { margin: 0; text-align: center; color: var(--color-muted); font-size: var(--text-sm); }
.divider { display: flex; align-items: center; gap: var(--space-3); color: var(--color-muted); font-size: var(--text-sm); }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--color-border); }
.provider-icon { width: 18px; height: 18px; flex: none; }

/* ---------- Signed-in frame (src/ui/AppShell.tsx) ---------- */
.shell { min-height: 100vh; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: min(var(--content-width), calc(100% - 2 * var(--space-6)));
  margin: 0 auto;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-border);
}
.topbar__error { width: min(var(--content-width), calc(100% - 2 * var(--space-6))); margin: var(--space-2) auto 0; }
.brand { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; font: 600 var(--text-lg)/1 var(--font-display); letter-spacing: var(--tracking-display); color: inherit; text-decoration: none; }
.account { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.account__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-sm); }
.content { width: min(var(--content-width), calc(100% - 2 * var(--space-6))); margin: 0 auto; padding: var(--space-8) 0 var(--space-16); outline: none; }

/* ---------- Email verification (src/ui/VerifyEmail.tsx) ---------- */
.verify-email { margin-bottom: var(--space-6); }
.verify-email__form { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.verify-email__form .field { grid-template-columns: auto auto; align-items: center; }
.verify-email__form input { width: 8ch; letter-spacing: 0.2em; text-align: center; }

/* ---------- Responsive ---------- */
@media (max-width: 760px) {
  .auth { grid-template-columns: 1fr; gap: var(--space-6); align-content: start; padding-top: var(--space-8); }
  .auth__title { font-size: var(--text-2xl); }
  .page-header { margin-bottom: var(--space-6); }
  .page-header__title { font-size: var(--text-2xl); }
  .content { padding-top: var(--space-6); }
}
@media (max-width: 480px) {
  .panel { padding: var(--space-4); }
  .card__header, .card__body, .card__footer { padding-left: var(--space-4); padding-right: var(--space-4); }
  .table th, .table td { padding-left: var(--space-4); padding-right: var(--space-4); }
  .account__label { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 3s; }
  .skeleton__line { animation: none; }
  .button, .meter__fill { transition: none; }
}

/* ---------- Your app ---------- */
/* Add page-specific styles below. Use tokens; add a class, don't restyle a tag. */
`;

// --------------------------------------------------------- sign-in views

export const STYLED_AUTH_CARD = `import type { FormEvent, ReactNode } from 'react';
import type { CredentialsForm } from '../../types/auth';
import { Button } from './Button';
import { TextField } from './Field';

interface AuthCardProps {
  appName: string;
  /** One line under the title: what the app is for. */
  tagline?: string;
  form: CredentialsForm;
  /** Social sign-in buttons, shown above the email form (see ProviderButtons). */
  providers?: ReactNode;
  /** Anything that belongs under the form: a magic-link form, a terms line. */
  children?: ReactNode;
}

/** The sign-in page: an intro column and a form column. Add to it through
 *  the \`providers\` and \`children\` slots; the two-column grid holds exactly
 *  these two columns, so don't add siblings to it. */
export function AuthCard({ appName, tagline, form, providers, children }: AuthCardProps) {
  const signUp = form.mode === 'sign-up';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.submit();
  }

  return (
    <main className="auth">
      <div className="auth__intro">
        <p className="auth__app">{appName}</p>
        <h1 className="auth__title">{signUp ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">{tagline ?? (signUp ? 'It takes a few seconds.' : 'Sign in to continue.')}</p>
      </div>
      <div className="auth__column">
        <form className="panel auth__form" onSubmit={onSubmit} noValidate aria-label={signUp ? 'Create account' : 'Sign in'}>
          {providers ? (
            <>
              {providers}
              <p className="divider" aria-hidden="true">or use email</p>
            </>
          ) : null}
          <TextField id="auth-email" label="Email" type="email" name="email" autoComplete="email" inputMode="email" autoFocus
            value={form.email} onChange={(event) => form.setEmail(event.target.value)} />
          <TextField id="auth-password" label="Password" type="password" name="password"
            autoComplete={signUp ? 'new-password' : 'current-password'}
            minLength={signUp ? form.passwordMinLength : undefined}
            hint={signUp ? \`At least \${form.passwordMinLength} characters.\` : undefined}
            value={form.password} onChange={(event) => form.setPassword(event.target.value)} />
          {form.error ? <p className="error" role="alert">{form.error}</p> : null}
          <Button type="submit" block disabled={!form.canSubmit} pending={form.pending}>
            {signUp ? 'Create account' : 'Sign in'}
          </Button>
          <p className="auth__switch">
            {signUp ? 'Already have an account?' : 'New here?'}{' '}
            <button type="button" className="link-button" onClick={form.toggleMode} disabled={form.pending}>
              {signUp ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        </form>
        {children}
      </div>
    </main>
  );
}
`;

export const PLAIN_AUTH_CARD = `import type { FormEvent, ReactNode } from 'react';
import type { CredentialsForm } from '../../types/auth';
import { Button } from './Button';
import { TextField } from './Field';

interface AuthCardProps {
  appName: string;
  /** One line under the title: what the app is for. */
  tagline?: string;
  form: CredentialsForm;
  /** Social sign-in buttons, shown above the email form (see ProviderButtons). */
  providers?: ReactNode;
  /** What belongs under the form: a magic-link form, a terms line. */
  children?: ReactNode;
}

/** The sign-in page. Add to it through the \`providers\` and \`children\` slots. */
export function AuthCard({ appName, tagline, form, providers, children }: AuthCardProps) {
  const signUp = form.mode === 'sign-up';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.submit();
  }

  return (
    <main>
      <h1>{signUp ? 'Create your account' : 'Sign in'} · {appName}</h1>
      {tagline ? <p>{tagline}</p> : null}
      {providers}
      <form onSubmit={onSubmit} noValidate aria-label={signUp ? 'Create account' : 'Sign in'}>
        <TextField id="auth-email" label="Email" type="email" name="email" autoComplete="email" inputMode="email" autoFocus
          value={form.email} onChange={(event) => form.setEmail(event.target.value)} />
        <TextField id="auth-password" label="Password" type="password" name="password"
          autoComplete={signUp ? 'new-password' : 'current-password'}
          minLength={signUp ? form.passwordMinLength : undefined}
          hint={signUp ? \`At least \${form.passwordMinLength} characters.\` : undefined}
          value={form.password} onChange={(event) => form.setPassword(event.target.value)} />
        {form.error ? <p role="alert">{form.error}</p> : null}
        <Button type="submit" disabled={!form.canSubmit} pending={form.pending}>
          {signUp ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      <p>
        <button type="button" onClick={form.toggleMode} disabled={form.pending}>
          {signUp ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      {children}
    </main>
  );
}
`;

export const STYLED_VERIFY_EMAIL = `import type { FormEvent } from 'react';
import type { EmailVerification } from '../../types/auth';

/** A quiet reminder above the page, never its main call to action. */
export function VerifyEmailPanel({ verification }: { verification: EmailVerification }) {
  if (verification.status === 'checking' || verification.status === 'verified') return null;
  if (verification.status === 'unavailable') {
    return (
      <div className="notice notice--warning verify-email" role="alert">
        <p className="notice__body">Could not check whether your email is verified.</p>
        <div className="notice__actions">
          <button type="button" className="button button--secondary button--sm" onClick={verification.retry}>Try again</button>
        </div>
      </div>
    );
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verification.submit();
  }
  return (
    <section className="notice notice--info verify-email" aria-label="Verify your email">
      <div className="notice__body">
        <p className="notice__title">Verify your email</p>
        <p>{verification.sent ? 'Enter the 6-digit code we emailed you.' : verification.entering ? 'Enter the 6-digit code from the latest email we sent you.' : 'We will email you a 6-digit code.'}</p>
        {verification.error ? <p className="error" role="alert">{verification.error}</p> : null}
      </div>
      {verification.entering ? (
        <form className="notice__actions verify-email__form" onSubmit={onSubmit} noValidate>
          <label className="visually-hidden" htmlFor="verify-code">Code</label>
          <input id="verify-code" className="control" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required placeholder="000000"
            value={verification.code} onChange={(event) => verification.setCode(event.target.value)} />
          <button type="submit" className="button button--sm" disabled={!verification.canSubmit} aria-busy={verification.pending}>Verify</button>
          <button type="button" className="button button--quiet button--sm" onClick={() => void verification.sendCode()} disabled={verification.pending}>Send a new code</button>
        </form>
      ) : (
        <div className="notice__actions">
          <button type="button" className="button button--secondary button--sm" onClick={() => void verification.sendCode()} disabled={verification.pending} aria-busy={verification.pending}>
            Email me a code
          </button>
          <button type="button" className="button button--quiet button--sm" onClick={verification.enterCode} disabled={verification.pending}>I already have a code</button>
        </div>
      )}
    </section>
  );
}
`;

// ----------------------------------------------------------------- the kit

export const STYLED_UI_KIT: InitScaffoldFile[] = [
  { path: 'src/ui/Button.tsx', content: `import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LinkProps } from '../routes';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
type Size = 'md' | 'sm';

function classes(variant: Variant, size: Size, block: boolean | undefined, extra: string | undefined) {
  return ['button', variant !== 'primary' && \`button--\${variant}\`, size === 'sm' && 'button--sm', block && 'button--block', extra]
    .filter(Boolean).join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  /** Disables the button and shows a spinner; keep the label so width holds. */
  pending?: boolean;
  icon?: ReactNode;
}

/** One primary button per view. Secondary for the alternative, quiet for
 *  low-emphasis actions in headers and rows, danger only for destructive ones. */
export function Button({ variant = 'primary', size = 'md', block, pending, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={classes(variant, size, block, className)} disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {pending ? <span className="spinner button__spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

interface LinkButtonProps {
  link: LinkProps;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  className?: string;
  children: ReactNode;
}

/** An in-app link styled as a button: \`<LinkButton link={linkTo(ROUTES.home)}>\`. */
export function LinkButton({ link, variant = 'secondary', size = 'md', block, className, children }: LinkButtonProps) {
  return <a className={classes(variant, size, block, className)} {...link}>{children}</a>;
}
` },
  { path: 'src/ui/Field.tsx', content: `import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

interface FieldChrome {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Shows "optional" next to the label. Required is the default and needs no mark. */
  optional?: boolean;
}

function describedBy(id: string, hint: ReactNode, error: string | null | undefined) {
  return [hint ? \`\${id}-hint\` : null, error ? \`\${id}-error\` : null].filter(Boolean).join(' ') || undefined;
}

/** The label/hint/error frame. Prefer TextField, SelectField and
 *  TextareaField; use Field directly for a control they don't cover. */
export function Field({ id, label, hint, error, optional, children }: FieldChrome & { children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        <span>{label}</span>
        {optional ? <span className="field__optional">Optional</span> : null}
      </label>
      {children}
      {hint ? <p id={\`\${id}-hint\`} className="field__hint">{hint}</p> : null}
      {error ? <p id={\`\${id}-error\`} className="field__error" role="alert">{error}</p> : null}
    </div>
  );
}

type TextFieldProps = FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function TextField({ id, label, hint, error, optional, className, ...input }: TextFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <input id={id} className={['control', className].filter(Boolean).join(' ')} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} required={!optional && input.required !== false} {...input} />
    </Field>
  );
}

export interface SelectOption { value: string; label: string; disabled?: boolean }

type SelectFieldProps = FieldChrome & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
  options: ReadonlyArray<SelectOption>;
  /** Shown as a disabled first option when the value is still empty. */
  placeholder?: string;
};

export function SelectField({ id, label, hint, error, optional, options, placeholder, className, ...select }: SelectFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <select id={id} className={['control', className].filter(Boolean).join(' ')} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} {...select}>
        {placeholder ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    </Field>
  );
}

type TextareaFieldProps = FieldChrome & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>;

export function TextareaField({ id, label, hint, error, optional, className, ...textarea }: TextareaFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <textarea id={id} className={['control', className].filter(Boolean).join(' ')} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} required={!optional && textarea.required !== false} {...textarea} />
    </Field>
  );
}

/** A checkbox with its label on the right. */
export function CheckboxField({ id, label, hint, className, ...input }: { id: string; label: ReactNode; hint?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  return (
    <div className="field field--inline">
      <input id={id} type="checkbox" className={className} aria-describedby={hint ? \`\${id}-hint\` : undefined} {...input} />
      <label className="field__label" htmlFor={id}><span>{label}</span></label>
      {hint ? <p id={\`\${id}-hint\`} className="field__hint" style={{ gridColumn: 2 }}>{hint}</p> : null}
    </div>
  );
}

/** Lays fields out side by side on wide screens and stacked on phones. */
export function FormRow({ children, min }: { children: ReactNode; min?: number }) {
  return <div className="form-row" style={min ? ({ '--form-row-min': \`\${min}px\` } as CSSProperties) : undefined}>{children}</div>;
}
` },
  { path: 'src/ui/Badge.tsx', content: `import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** A small status label. Tone carries meaning (success/warning/danger);
 *  don't pick tones for decoration. */
export function Badge({ tone = 'neutral', dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={tone === 'neutral' ? 'badge' : \`badge badge--\${tone}\`}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
` },
  { path: 'src/ui/Tabs.tsx', content: `import type { KeyboardEvent } from 'react';

export interface Tab<T extends string> { id: T; label: string }

interface TabsProps<T extends string> {
  tabs: ReadonlyArray<Tab<T>>;
  value: T;
  onChange(id: T): void;
  /** What the set of tabs is, for assistive tech ("Sections"). */
  label: string;
}

/** Segmented tabs. The caller renders the panel for \`value\`; give it
 *  \`role="tabpanel"\` and \`id={\`\${tab}-panel\`}\` so the two are linked. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: TabsProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === value);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    onChange(next.id);
    (event.currentTarget.querySelector<HTMLButtonElement>(\`#\${next.id}-tab\`))?.focus();
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button key={tab.id} id={\`\${tab.id}-tab\`} type="button" role="tab" className="tab" aria-selected={selected}
            aria-controls={\`\${tab.id}-panel\`} tabIndex={selected ? 0 : -1} onClick={() => onChange(tab.id)}>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
` },
  { path: 'src/ui/Stat.tsx', content: `import type { ReactNode } from 'react';

interface StatProps {
  label: string;
  value: ReactNode;
  /** A unit or denominator shown small after the value: "/ 100", "min". */
  suffix?: ReactNode;
  /** One line under the value: a delta, a comparison, a hint. */
  detail?: ReactNode;
  detailTone?: 'neutral' | 'success' | 'danger';
  /** 0–1 draws a progress meter under the value. */
  progress?: number;
}

/** A single number with its label. Use a few per page in a <Grid>, never
 *  one per metric you have; the page's main number belongs in the header. */
export function Stat({ label, value, suffix, detail, detailTone = 'neutral', progress }: StatProps) {
  return (
    <div className="stat">
      <p className="eyebrow">{label}</p>
      <p className="stat__value">{value}{suffix ? <small>{suffix}</small> : null}</p>
      {progress !== undefined ? (
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={label}>
          <div className="meter__fill" style={{ width: \`\${Math.min(100, Math.max(0, progress * 100))}%\` }} />
        </div>
      ) : null}
      {detail ? <p className={detailTone === 'neutral' ? 'stat__detail' : \`stat__detail stat__detail--\${detailTone}\`}>{detail}</p> : null}
    </div>
  );
}
` },
  { path: 'src/ui/Table.tsx', content: `import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** Renders the cell; defaults to the row's property named \`key\`. */
  render?(row: Row): ReactNode;
  numeric?: boolean;
  width?: string;
}

interface TableProps<Row> {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey(row: Row): string;
  /** Shown inside the table when there are no rows. */
  empty?: ReactNode;
  caption?: string;
}

/** Rows of like things. Put it in a <Card flush> so the header sits on the
 *  card edge. For actions per row, add a column that renders quiet buttons. */
export function Table<Row extends object>({ columns, rows, rowKey, empty = 'Nothing here yet.', caption }: TableProps<Row>) {
  return (
    <div className="table-wrap">
      <table className="table">
        {caption ? <caption className="visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric ? 'is-numeric' : undefined} style={column.width ? { width: column.width } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="table__empty" colSpan={columns.length}>{empty}</td></tr>
          ) : rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'is-numeric' : undefined}>
                  {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
` },
  { path: 'src/ui/Card.tsx', content: `import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Buttons or a badge in the header's right corner. */
  actions?: ReactNode;
  /** Removes body padding, for a Table or a list that reaches the edges. */
  flush?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

/** A titled group. Use cards for peers (a list, a form, a chart), not as a
 *  wrapper around everything: a page of nothing but cards has no hierarchy. */
export function Card({ title, description, actions, flush, footer, children }: CardProps) {
  const hasHeader = title || description || actions;
  return (
    <section className="card">
      {hasHeader ? (
        <header className="card__header">
          <div className="card__heading">
            {title ? <h2 className="card__title">{title}</h2> : null}
            {description ? <p className="card__description">{description}</p> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}
` },
  { path: 'src/ui/layout.tsx', content: `import type { CSSProperties, ReactNode } from 'react';

type Space = 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;
const gap = (n: Space) => \`var(--space-\${n})\`;

/** Vertical rhythm: children stacked with one gap. */
export function Stack({ gap: g = 4, children }: { gap?: Space; children: ReactNode }) {
  return <div className="stack" style={{ '--stack-gap': gap(g) } as CSSProperties}>{children}</div>;
}

/** Items in a row that wrap on narrow screens. */
export function Inline({ gap: g = 2, align = 'center', justify = 'start', children }: {
  gap?: Space; align?: 'start' | 'center' | 'end' | 'baseline'; justify?: 'start' | 'end' | 'between' | 'center'; children: ReactNode;
}) {
  const style = {
    '--inline-gap': gap(g),
    '--inline-align': align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : align,
    '--inline-justify': justify === 'between' ? 'space-between' : justify === 'start' ? 'flex-start' : justify === 'end' ? 'flex-end' : justify,
  } as CSSProperties;
  return <div className="inline" style={style}>{children}</div>;
}

/** Equal columns that reflow: as many as fit at \`min\` px each. */
export function Grid({ min = 220, gap: g = 4, children }: { min?: number; gap?: Space; children: ReactNode }) {
  return <div className="grid" style={{ '--grid-min': \`\${min}px\`, '--grid-gap': gap(g) } as CSSProperties}>{children}</div>;
}

interface PageHeaderProps {
  title: string;
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** The page's primary action (one Button) and at most one secondary. */
  actions?: ReactNode;
}

/** Every page starts with one of these: the one h1, and the main action. */
export function PageHeader({ title, eyebrow, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="page-header__title">{title}</h1>
        {description ? <p className="page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
` },
  { path: 'src/ui/Dialog.tsx', content: `import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  /** Buttons for the footer; the Cancel button is added for you. */
  actions?: ReactNode;
  children: ReactNode;
}

/** A native <dialog>: focus trapping, Escape and the backdrop come from the
 *  browser. Keep one form per dialog and submit it from \`actions\`. */
export function Dialog({ open, title, onClose, actions, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog__header">
        <h2 id="dialog-title" className="dialog__title">{title}</h2>
        <Button variant="quiet" size="sm" onClick={onClose} aria-label="Close">✕</Button>
      </div>
      <div className="dialog__body">{children}</div>
      <div className="dialog__footer">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {actions}
      </div>
    </dialog>
  );
}
` },
  { path: 'src/ui/Notice.tsx', content: `import type { ReactNode } from 'react';

interface NoticeProps {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  /** Buttons on the right. */
  actions?: ReactNode;
  children: ReactNode;
}

/** An inline message about the current page: a result, a warning, a
 *  state the person should know about. Not for marketing or tips. */
export function Notice({ tone = 'info', title, actions, children }: NoticeProps) {
  return (
    <div className={\`notice notice--\${tone}\`} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <div className="notice__body">
        {title ? <p className="notice__title">{title}</p> : null}
        <p>{children}</p>
      </div>
      {actions ? <div className="notice__actions">{actions}</div> : null}
    </div>
  );
}
` },
  { path: 'src/ui/Skeleton.tsx', content: `/** Placeholder lines while data loads. Match the shape of what will appear
 *  (3 lines for a short list, 1 wide line for a stat) so the page doesn't jump. */
export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  const widths = ['100%', '82%', '64%', '90%', '70%'];
  return (
    <div className="skeleton" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton__line" style={{ width: widths[i % widths.length] }} />)}
    </div>
  );
}
` },
  { path: 'src/ui/ProviderButtons.tsx', content: `import type { ProviderSignIn, SignInProvider } from '../../types/auth';
import { Button } from './Button';

const LABEL: Record<SignInProvider, string> = { google: 'Google', github: 'GitHub', discord: 'Discord' };

function Icon({ provider }: { provider: SignInProvider }) {
  if (provider === 'google') {
    return (
      <svg className="provider-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4.1-3.1z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4.1 3.1A7.2 7.2 0 0 1 12 4.8z" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg className="provider-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
      </svg>
    );
  }
  return (
    <svg className="provider-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#5865F2" d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.5a18 18 0 0 1 4.4 2.2 15 15 0 0 0-15.2 0A18 18 0 0 1 8.8 3.5L8.6 3a19.8 19.8 0 0 0-4.9 1.5C.6 9.1-.2 13.6.2 18a19.9 19.9 0 0 0 6 3l1.3-2a12.8 12.8 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12 0l.5.4-2 1 1.3 2a19.9 19.9 0 0 0 6-3c.5-5.1-.8-9.6-3.5-13.6zM8 15.3c-1.2 0-2.1-1.1-2.1-2.4S6.8 10.5 8 10.5s2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4zm8 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4z" />
    </svg>
  );
}

/** "Continue with …" buttons for SIGN_IN_PROVIDERS (src/config.ts). The
 *  SignInPage passes useProviderSignIn's state; this view only renders it. */
export function ProviderButtons({ providers, signIn }: { providers: ReadonlyArray<SignInProvider>; signIn: ProviderSignIn }) {
  if (providers.length === 0) return null;
  return (
    <div className="auth__providers">
      {providers.map((provider) => (
        <Button key={provider} variant="secondary" icon={<Icon provider={provider} />} pending={signIn.pending === provider}
          disabled={signIn.pending !== null} onClick={() => void signIn.start(provider)}>
          Continue with {LABEL[provider]}
        </Button>
      ))}
      {signIn.error ? <p className="error" role="alert">{signIn.error}</p> : null}
    </div>
  );
}
` },
  { path: 'src/ui/index.ts', content: `// The app's UI kit. Pages import from here; styles live in src/styles/app.css
// and read src/styles/tokens.css. See .agents/skills/design/SKILL.md.
export { Badge, type Tone } from './Badge';
export { Button, LinkButton } from './Button';
export { Card } from './Card';
export { Dialog } from './Dialog';
export { CheckboxField, Field, FormRow, SelectField, TextField, TextareaField, type SelectOption } from './Field';
export { Grid, Inline, PageHeader, Stack } from './layout';
export { Notice } from './Notice';
export { Skeleton } from './Skeleton';
export { Stat } from './Stat';
export { Table, type Column } from './Table';
export { Tabs, type Tab } from './Tabs';
export { EmptyState } from './feedback';
` },
];

export const PLAIN_UI_KIT: InitScaffoldFile[] = [
  { path: 'src/ui/Button.tsx', content: `import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LinkProps } from '../routes';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
type Size = 'md' | 'sm';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  /** Disables the button while something it started is still running. */
  pending?: boolean;
  icon?: ReactNode;
}

/** One primary button per view. Secondary for the alternative, quiet for
 *  low-emphasis actions in headers and rows, danger only for destructive ones. */
export function Button({ variant = 'primary', size = 'md', block, pending, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={className} data-variant={variant} data-size={size} data-block={block || undefined}
      disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {icon}
      {children}
    </button>
  );
}

interface LinkButtonProps {
  link: LinkProps;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  className?: string;
  children: ReactNode;
}

/** An in-app link styled as a button: \`<LinkButton link={linkTo(ROUTES.home)}>\`. */
export function LinkButton({ link, variant = 'secondary', size = 'md', block, className, children }: LinkButtonProps) {
  return <a className={className} data-variant={variant} data-size={size} data-block={block || undefined} {...link}>{children}</a>;
}
` },
  { path: 'src/ui/Field.tsx', content: `import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

interface FieldChrome {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Shows "optional" next to the label. Required is the default and needs no mark. */
  optional?: boolean;
}

function describedBy(id: string, hint: ReactNode, error: string | null | undefined) {
  return [hint ? \`\${id}-hint\` : null, error ? \`\${id}-error\` : null].filter(Boolean).join(' ') || undefined;
}

/** The label/hint/error frame. Prefer TextField, SelectField and
 *  TextareaField; use Field directly for a control they don't cover. */
export function Field({ id, label, hint, error, optional, children }: FieldChrome & { children: ReactNode }) {
  return (
    <p>
      <label htmlFor={id}>{label}{optional ? ' (optional)' : ''}</label><br />
      {children}
      {hint ? <><br /><small id={\`\${id}-hint\`}>{hint}</small></> : null}
      {error ? <><br /><small id={\`\${id}-error\`} role="alert">{error}</small></> : null}
    </p>
  );
}

type TextFieldProps = FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function TextField({ id, label, hint, error, optional, className, ...input }: TextFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <input id={id} className={className} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} required={!optional && input.required !== false} {...input} />
    </Field>
  );
}

export interface SelectOption { value: string; label: string; disabled?: boolean }

type SelectFieldProps = FieldChrome & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
  options: ReadonlyArray<SelectOption>;
  /** Shown as a disabled first option when the value is still empty. */
  placeholder?: string;
};

export function SelectField({ id, label, hint, error, optional, options, placeholder, className, ...select }: SelectFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <select id={id} className={className} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} {...select}>
        {placeholder ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    </Field>
  );
}

type TextareaFieldProps = FieldChrome & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>;

export function TextareaField({ id, label, hint, error, optional, className, ...textarea }: TextareaFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      <textarea id={id} className={className} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} required={!optional && textarea.required !== false} {...textarea} />
    </Field>
  );
}

/** A checkbox with its label on the right. */
export function CheckboxField({ id, label, hint, className, ...input }: { id: string; label: ReactNode; hint?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  return (
    <p>
      <input id={id} type="checkbox" className={className} aria-describedby={hint ? \`\${id}-hint\` : undefined} {...input} />{' '}
      <label htmlFor={id}>{label}</label>
      {hint ? <><br /><small id={\`\${id}-hint\`}>{hint}</small></> : null}
    </p>
  );
}

/** Lays fields out side by side on wide screens and stacked on phones. */
export function FormRow({ children, min }: { children: ReactNode; min?: number }) {
  return <div data-min={min}>{children}</div>;
}
` },
  { path: 'src/ui/Badge.tsx', content: `import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** A small status label. Tone carries meaning (success/warning/danger);
 *  don't pick tones for decoration. */
export function Badge({ tone = 'neutral', dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span data-tone={tone} data-dot={dot || undefined}>{children}</span>;
}
` },
  { path: 'src/ui/Tabs.tsx', content: `import type { KeyboardEvent } from 'react';

export interface Tab<T extends string> { id: T; label: string }

interface TabsProps<T extends string> {
  tabs: ReadonlyArray<Tab<T>>;
  value: T;
  onChange(id: T): void;
  /** What the set of tabs is, for assistive tech ("Sections"). */
  label: string;
}

/** Tabs. The caller renders the panel for \`value\`; give it
 *  \`role="tabpanel"\` and \`id={\`\${tab}-panel\`}\` so the two are linked. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: TabsProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === value);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    onChange(next.id);
    (event.currentTarget.querySelector<HTMLButtonElement>(\`#\${next.id}-tab\`))?.focus();
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button key={tab.id} id={\`\${tab.id}-tab\`} type="button" role="tab" aria-selected={selected}
            aria-controls={\`\${tab.id}-panel\`} tabIndex={selected ? 0 : -1} onClick={() => onChange(tab.id)}>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
` },
  { path: 'src/ui/Stat.tsx', content: `import type { ReactNode } from 'react';

interface StatProps {
  label: string;
  value: ReactNode;
  /** A unit or denominator shown small after the value: "/ 100", "min". */
  suffix?: ReactNode;
  /** One line under the value: a delta, a comparison, a hint. */
  detail?: ReactNode;
  detailTone?: 'neutral' | 'success' | 'danger';
  /** 0–1 draws a progress meter under the value. */
  progress?: number;
}

/** A single number with its label. Use a few per page in a <Grid>, never
 *  one per metric you have; the page's main number belongs in the header. */
export function Stat({ label, value, suffix, detail, detailTone = 'neutral', progress }: StatProps) {
  return (
    <div>
      <p>{label}</p>
      <p><strong>{value}</strong>{suffix ? <small> {suffix}</small> : null}</p>
      {progress !== undefined ? <progress max={100} value={Math.round(Math.min(100, Math.max(0, progress * 100)))} aria-label={label} /> : null}
      {detail ? <p data-tone={detailTone}>{detail}</p> : null}
    </div>
  );
}
` },
  { path: 'src/ui/Table.tsx', content: `import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** Renders the cell; defaults to the row's property named \`key\`. */
  render?(row: Row): ReactNode;
  numeric?: boolean;
  width?: string;
}

interface TableProps<Row> {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey(row: Row): string;
  /** Shown inside the table when there are no rows. */
  empty?: ReactNode;
  caption?: string;
}

/** Rows of like things. For actions per row, add a column that renders buttons. */
export function Table<Row extends object>({ columns, rows, rowKey, empty = 'Nothing here yet.', caption }: TableProps<Row>) {
  return (
    <table>
      {caption ? <caption>{caption}</caption> : null}
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} scope="col" style={column.width ? { width: column.width } : undefined}>{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length}>{empty}</td></tr>
        ) : rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.key} align={column.numeric ? 'right' : undefined}>
                {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
` },
  { path: 'src/ui/Card.tsx', content: `import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Buttons or a badge in the header's right corner. */
  actions?: ReactNode;
  /** Removes body padding, for a Table or a list that reaches the edges. */
  flush?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

/** A titled group. Use cards for peers (a list, a form, a chart), not as a
 *  wrapper around everything: a page of nothing but cards has no hierarchy. */
export function Card({ title, description, actions, flush, footer, children }: CardProps) {
  return (
    <section data-flush={flush || undefined}>
      {title || description || actions ? (
        <header>
          {title ? <h2>{title}</h2> : null}
          {description ? <p>{description}</p> : null}
          {actions ? <div>{actions}</div> : null}
        </header>
      ) : null}
      <div>{children}</div>
      {footer ? <footer>{footer}</footer> : null}
    </section>
  );
}
` },
  { path: 'src/ui/layout.tsx', content: `import type { ReactNode } from 'react';

type Space = 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;

/** Vertical rhythm: children stacked with one gap. */
export function Stack({ gap: g = 4, children }: { gap?: Space; children: ReactNode }) {
  return <div data-gap={g}>{children}</div>;
}

/** Items in a row that wrap on narrow screens. */
export function Inline({ gap: g = 2, align = 'center', justify = 'start', children }: {
  gap?: Space; align?: 'start' | 'center' | 'end' | 'baseline'; justify?: 'start' | 'end' | 'between' | 'center'; children: ReactNode;
}) {
  return <div data-gap={g} data-align={align} data-justify={justify}>{children}</div>;
}

/** Equal columns that reflow: as many as fit at \`min\` px each. */
export function Grid({ min = 220, gap: g = 4, children }: { min?: number; gap?: Space; children: ReactNode }) {
  return <div data-min={min} data-gap={g}>{children}</div>;
}

interface PageHeaderProps {
  title: string;
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** The page's primary action (one Button) and at most one secondary. */
  actions?: ReactNode;
}

/** Every page starts with one of these: the one h1, and the main action. */
export function PageHeader({ title, eyebrow, description, actions }: PageHeaderProps) {
  return (
    <header>
      {eyebrow ? <p>{eyebrow}</p> : null}
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}
` },
  { path: 'src/ui/Dialog.tsx', content: `import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  /** Buttons for the footer; the Cancel button is added for you. */
  actions?: ReactNode;
  children: ReactNode;
}

/** A native <dialog>: focus trapping, Escape and the backdrop come from the
 *  browser. Keep one form per dialog and submit it from \`actions\`. */
export function Dialog({ open, title, onClose, actions, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby="dialog-title" onClose={onClose}>
      <h2 id="dialog-title">{title}</h2>
      <div>{children}</div>
      <p>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>{' '}
        {actions}
      </p>
    </dialog>
  );
}
` },
  { path: 'src/ui/Notice.tsx', content: `import type { ReactNode } from 'react';

interface NoticeProps {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  /** Buttons on the right. */
  actions?: ReactNode;
  children: ReactNode;
}

/** An inline message about the current page: a result, a warning, a
 *  state the person should know about. Not for marketing or tips. */
export function Notice({ tone = 'info', title, actions, children }: NoticeProps) {
  return (
    <div data-tone={tone} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      {title ? <p><strong>{title}</strong></p> : null}
      <p>{children}</p>
      {actions ? <p>{actions}</p> : null}
    </div>
  );
}
` },
  { path: 'src/ui/Skeleton.tsx', content: `/** Placeholder while data loads. Match the shape of what will appear
 *  (3 lines for a short list, 1 for a stat) so the page doesn't jump. */
export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return <p role="status" aria-label={label} aria-busy="true" data-lines={lines}>{label}…</p>;
}
` },
  { path: 'src/ui/ProviderButtons.tsx', content: `import type { ProviderSignIn, SignInProvider } from '../../types/auth';
import { Button } from './Button';

const LABEL: Record<SignInProvider, string> = { google: 'Google', github: 'GitHub', discord: 'Discord' };

/** "Continue with …" buttons for SIGN_IN_PROVIDERS (src/config.ts). The
 *  SignInPage passes useProviderSignIn's state; this view only renders it. */
export function ProviderButtons({ providers, signIn }: { providers: ReadonlyArray<SignInProvider>; signIn: ProviderSignIn }) {
  if (providers.length === 0) return null;
  return (
    <p>
      {providers.map((provider) => (
        <Button key={provider} variant="secondary" pending={signIn.pending === provider}
          disabled={signIn.pending !== null} onClick={() => void signIn.start(provider)}>
          Continue with {LABEL[provider]}
        </Button>
      ))}
      {signIn.error ? <span role="alert">{signIn.error}</span> : null}
    </p>
  );
}
` },
  { path: 'src/ui/index.ts', content: `// The app's UI kit. Pages import from here; styles live in src/styles/app.css
// and read src/styles/tokens.css. See .agents/skills/design/SKILL.md.
export { Badge, type Tone } from './Badge';
export { Button, LinkButton } from './Button';
export { Card } from './Card';
export { Dialog } from './Dialog';
export { CheckboxField, Field, FormRow, SelectField, TextField, TextareaField, type SelectOption } from './Field';
export { Grid, Inline, PageHeader, Stack } from './layout';
export { Notice } from './Notice';
export { Skeleton } from './Skeleton';
export { Stat } from './Stat';
export { Table, type Column } from './Table';
export { Tabs, type Tab } from './Tabs';
export { EmptyState } from './feedback';
` },
];
