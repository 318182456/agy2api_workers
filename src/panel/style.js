export const panelStyle = String.raw`
/* Shared console design. See DESIGN.md for decisions and reference versions. */
:root {
  color-scheme: light;
  font:
    13px/1.6 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    "Microsoft YaHei",
    sans-serif;
  color: var(--ink);
  background: var(--canvas);
  --accent: #147d64;
  --accent-hover: #106650;
  --accent-soft: #edf7f2;
  --focus-ring: #83c5ad;
  --ink: #20272c;
  --text-secondary: #4f5c65;
  --muted: #606e76;
  --border: #e2e7e8;
  --border-soft: #edf0f1;
  --canvas: #f6f8f8;
  --surface-muted: #f8faf9;
  --sidebar: 212px;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  min-width: 320px;
  -webkit-font-smoothing: antialiased;
}
a {
  color: var(--accent);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
button,
input,
select,
textarea {
  font: inherit;
  min-height: 32px;
  border-radius: 6px;
  max-width: 100%;
}
button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 11px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-weight: 550;
  line-height: 1.5;
  text-decoration: none;
  transition:
    background 0.15s,
    border-color 0.15s,
    box-shadow 0.15s;
  font-size: 12px;
  box-shadow: 0 1px 2px #172b2210;
}
button:hover,
.button:hover {
  background: var(--accent-hover);
  text-decoration: none;
}
button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
  box-shadow: none;
}
button[inert] {
  opacity: 0.5;
  cursor: wait;
}
.secondary {
  background: #fff;
  color: var(--text-secondary);
  border-color: var(--border);
  box-shadow: 0 1px 1px #172b2205;
}
.secondary:hover {
  background: var(--surface-muted);
  border-color: #bfcac6;
  color: var(--ink);
}
.danger {
  background: #fff;
  color: #b33540;
  border-color: #eccfd2;
}
.danger:hover {
  background: #fff1f2;
  border-color: #dfafb5;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 3px;
}
input,
select,
textarea {
  padding: 7px 10px;
  border: 1px solid #d9e0df;
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  max-width: 100%;
  min-height: 34px;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
input:focus,
select:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px #147d6412;
  outline: none;
}
input[type="checkbox"] {
  min-height: 0;
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  vertical-align: middle;
  box-shadow: none;
  padding: 0;
}
textarea {
  width: 100%;
  resize: vertical;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
}
label {
  display: block;
  margin: 12px 0 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}
form > input:not([type="checkbox"]),
form > select {
  width: 100%;
}
form > button {
  margin-top: 18px;
}
small {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.65;
}
p {
  color: var(--muted);
  margin: 5px 0 12px;
  line-height: 1.75;
}
h1,
h2,
h3 {
  line-height: 1.35;
  color: var(--ink);
  font-size: 13px;
  margin: 18px 0 10px;
}
h1 {
  font-size: 23px;
  font-weight: 650;
  letter-spacing: -0.6px;
  margin: 0 0 5px;
}
h2 {
  font-size: 14px;
  font-weight: 650;
  margin: 0 0 6px;
}
h3 {
  font-size: 13px;
  margin: 22px 0 10px;
}
.app-shell {
  min-height: 100vh;
}
.sidebar {
  width: var(--sidebar);
  background: #1b2327;
  position: fixed;
  inset: 0 auto 0 0;
  border-right: 1px solid #182024;
  display: flex;
  flex-direction: column;
  padding: 22px 12px 16px;
  z-index: 20;
  color: #c3cdd0;
  box-shadow: none;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #f3f7f5;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.5px;
}
.brand:hover {
  text-decoration: none;
}
.brand > div > span {
  display: block;
  font-size: 10px;
  font-weight: 450;
  color: #91a3a7;
  letter-spacing: 1px;
  margin-top: 2px;
}
.brand-mark svg {
  display: block;
  width: 100%;
  height: 100%;
}
.brand-mark {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: transparent;
  color: white;
  font-size: 22px;
  font-weight: 700;
  box-shadow: inset 0 0 0 1px #ffffff18;
  padding: 0;
}
.sidebar > .brand {
  padding: 0 10px 20px;
  padding-bottom: 20px;
}
nav {
  overflow: auto;
  margin-top: 0;
  padding: 0;
}
nav a {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 38px;
  margin: 3px 0;
  border-radius: 6px;
  padding: 9px 12px;
  color: #b1bec3;
  font-size: 12px;
  font-weight: 500;
}
nav a:hover {
  background: #ffffff08;
  color: #fff;
  text-decoration: none;
}
nav a[aria-current="page"] {
  background: #2c3e39;
  color: #c0f0d9;
  box-shadow: inset 2px 0 0 #54c89c;
}
.nav-icon {
  font-size: 11px;
  opacity: 0.9;
  font-weight: 650;
  letter-spacing: 0.5px;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.nav-label {
  font-size: 10px;
  letter-spacing: 1.2px;
  color: #8e9fa4;
  padding: 12px 12px 8px;
}
.sidebar-footer {
  font-size: 10px;
  color: #9dafb3;
  margin-top: auto;
  padding: 16px 8px 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid #ffffff0f;
  line-height: 1.5;
}
.version {
  margin-left: auto;
  font-size: 10px;
  font-family: ui-monospace, Consolas, monospace;
  color: #acbcbf;
}
.connection-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  background: #3ca982;
  border-radius: 50%;
  margin-right: 4px;
  flex-shrink: 0;
}
main {
  margin-left: var(--sidebar);
  min-width: 0;
}
.topbar {
  height: 54px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  background: #ffffffed;
  padding: 0 28px;
  color: var(--muted);
  font-size: 12px;
  position: sticky;
  top: 0;
  z-index: 15;
  backdrop-filter: blur(10px);
}
.topbar .breadcrumb > span[aria-hidden] {
  margin: 0 12px;
  color: #c2cad7;
}
#pageBreadcrumb {
  color: var(--ink);
  font-size: 11px;
}
.runtime-region {
  font-size: 10px;
  color: var(--muted);
  max-width: 210px;
  overflow-wrap: anywhere;
}
.topbar-actions button {
  white-space: nowrap;
  flex-shrink: 0;
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.topbar button {
  padding: 4px 9px;
  font-size: 11px;
  min-height: 28px;
  box-shadow: none;
}
.main-inner {
  max-width: 1600px;
  margin: 0 auto;
  padding: 26px 28px 56px;
}
.page-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 22px;
}
.page-heading p {
  font-size: 12px;
  margin: 4px 0 0;
  color: var(--muted);
}
.eyebrow {
  font-size: 9px !important;
  letter-spacing: 1.7px;
  color: var(--muted) !important;
  margin: 0 0 9px !important;
}
.page-version {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  background: #fff;
  font:
    10px ui-monospace,
    Consolas,
    monospace;
}
.card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 19px 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 2px #172b2203;
}
.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.card-heading h2 {
  margin-bottom: 4px;
}
.card-heading p {
  margin: 0;
  font-size: 11px;
  max-width: 70ch;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.card > button {
  margin: 0 8px 14px 0;
  padding: 6px 10px;
  font-size: 12px;
  margin-right: 6px;
  margin-bottom: 6px;
}
.card form > button {
  margin-right: 8px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
  margin: 12px 0;
}
.filters label {
  margin: 0;
  flex: 1 1 150px;
  min-width: 145px;
  color: var(--muted);
  font-weight: 450;
  font-size: 11px;
}
.filters input,
.filters select {
  display: block;
  width: 100%;
  margin-top: 5px;
  font-size: 12px;
  min-height: 32px;
}
.account-filters {
  padding: 10px 12px;
  background: var(--surface-muted);
  border: 1px solid #edf0f6;
  border-radius: 6px;
}
.account-filters label:first-child {
  flex-grow: 2;
  flex: 2 1 280px;
  max-width: 460px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 14px 0;
  margin-bottom: 18px;
}
.metric {
  padding: 15px 17px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  min-width: 0;
}
.metric small {
  display: block;
  font-size: 11px;
  color: var(--muted);
}
.metric strong {
  display: block;
  font-size: 26px;
  letter-spacing: -0.8px;
  font-weight: 650;
  color: var(--ink);
  margin-top: 7px;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.account-metrics {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-top: 0;
  margin-bottom: 20px;
  gap: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.account-metrics .metric {
  padding: 13px 17px;
  border: 0;
  border-right: 1px solid var(--border-soft);
  border-radius: 0;
  box-shadow: none;
}
.account-metrics .metric strong {
  font-size: 22px;
  margin-top: 4px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
/* Preserve readable columns; narrow screens scroll tables instead of stacking characters. */
.data-table { min-width: 760px; }
.key-table { min-width: 900px; }
.credential-table { min-width: 920px; }
.issue-table, .node-table { min-width: 1120px; }
#keysBody td:first-child { min-width: 125px; }
#keysBody td:nth-child(3) { min-width: 145px; }
#keysBody td:nth-child(4) { min-width: 70px; white-space: nowrap; }
th {
  padding: 10px 12px;
  background: var(--surface-muted);
  color: #66736c;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  border-block: 1px solid var(--border);
  text-align: left;
  letter-spacing: 0.15px;
}
td {
  padding: 11px 12px;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: middle;
  color: var(--text-secondary);
  white-space: pre-line;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
td:first-child {
  color: var(--ink);
}
tbody tr:hover {
  background: #f8fbf9;
}
tbody tr:last-child td {
  border-bottom: 0;
}
.scroll {
  overflow: auto;
  scrollbar-width: thin;
}
#credentials td:first-child {
  width: 36px;
}
#credentials td:nth-child(2) {
  min-width: 190px;
  max-width: 280px;
  font-weight: 500;
}
#credentials td:nth-child(3) {
  white-space: nowrap;
}
#credentials td:nth-child(4) {
  min-width: 130px;
}
#credentials td:nth-child(5) {
  min-width: 140px;
  font-size: 11px;
}
#credentials td:last-child {
  min-width: 180px;
}
td button {
  font-size: 11px;
  padding: 4px 8px;
  margin: 2px 4px 2px 0;
  min-height: 28px;
  box-shadow: none;
}
td .row-menu {
  display: inline-block;
  position: relative;
  vertical-align: middle;
  font-weight: 400;
}
td .row-menu > summary {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
  white-space: nowrap;
  min-height: 28px;
}
td .row-menu[open] {
  display: inline-block;
  margin-top: 0;
  vertical-align: top;
}
td .row-menu .action-menu {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 8px;
  min-width: 210px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-top: 6px;
}
td .row-menu .action-menu button {
  margin: 0;
  white-space: nowrap;
}
.quota-details {
  background: var(--surface-muted);
}
.quota-details progress {
  width: 70px;
  vertical-align: middle;
  margin-right: 8px;
  accent-color: var(--accent);
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0 0;
  font-size: 11px;
  color: var(--muted);
}
.pagination button {
  padding: 4px 9px;
  margin-left: 6px;
  font-size: 11px;
  min-height: 28px;
}
.pagination button:disabled {
  color: #a5afbf;
  background: #f4f6f9;
  border-color: #e3e8ef;
  box-shadow: none;
  opacity: 1;
  pointer-events: none;
}
.help {
  font-size: 12px;
  color: #7e8b9f;
  margin: 10px 0;
}
.help summary {
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}
.help p {
  margin: 10px 0;
  font-size: 12px;
}
.filter-panel,
.batch-panel {
  padding: 12px 14px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 12px 0;
}
.filter-panel > summary,
.batch-panel > summary {
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}
.batch-panel #selectionCount {
  font-size: 11px;
  color: var(--accent);
  margin-left: 8px;
}
.batch-panel button {
  margin: 10px 6px 0 0;
}
.card > summary {
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  color: #4d5f7b;
}
.card[open] > summary {
  margin-bottom: 16px;
}
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-top: 16px;
  margin-bottom: 12px;
}
.tab {
  border-radius: 0;
  background: none;
  color: #94a0b2;
  padding: 8px 12px;
  border-bottom: 2px solid transparent;
  font-size: 12px;
}
.tab:hover {
  background: #f9faff;
}
.tab[aria-selected="true"] {
  color: var(--accent);
  border-bottom-color: var(--accent);
  background: none;
}
.page-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
.page-grid .card {
  min-width: 0;
}
.narrow-page {
  max-width: 980px;
}
.settings-form {
  max-width: 690px;
}
.settings-form small {
  display: block;
}
.form-divider {
  border-top: 1px solid var(--border);
  padding-top: 18px;
  margin-top: 24px;
}
.switch-label {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 450;
  padding: 7px 0;
  margin: 0;
  font-size: 12px;
}
.step-label {
  color: var(--accent);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.6px;
  margin-bottom: 12px;
}
pre {
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font:
    12px/1.7 ui-monospace,
    Consolas,
    "Microsoft YaHei",
    monospace;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  max-width: 100%;
}
pre:empty {
  display: none;
}
.endpoint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.endpoint:last-child {
  border-bottom: 0;
}
.endpoint span {
  display: block;
  color: #75849b;
  font-size: 12px;
  margin-bottom: 8px;
}
.endpoint code {
  display: block;
  color: #384e77;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.endpoint button {
  font-size: 12px;
  padding: 6px 12px;
}
.empty-state {
  text-align: center;
  color: #9ba6b8;
  padding: 30px 15px;
  font-size: 12px;
}
.status-bar {
  position: fixed;
  inset: auto 0 0 0;
  padding: 7px 28px;
  background: #ffffffed;
  backdrop-filter: blur(8px);
  border-top: 1px solid var(--border);
  font-size: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--muted);
  z-index: 25;
  max-height: 74px;
  overflow: auto;
  left: var(--sidebar);
  bottom: 0;
  box-shadow: none;
}
.login-screen {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 36px 20px;
  background: #f1f4f3;
}
.login-box {
  width: 100%;
  max-width: 390px;
  padding: 32px;
  background: #fff;
  border: 1px solid #dce3df;
  border-radius: 12px;
  box-shadow: 0 12px 45px #213b2e08;
}
.login-box .brand {
  margin-bottom: 32px;
  color: var(--ink);
}
.login-box h1 {
  font-size: 22px;
  letter-spacing: -0.5px;
}
.login-box p {
  font-size: 12px;
  margin-bottom: 22px;
}
.login-box input,
.login-box form > button {
  width: 100%;
  min-height: 38px;
}
.login-box small {
  display: block;
  margin-top: 20px;
  font-size: 10px;
  color: var(--muted);
  padding-top: 16px;
  border-top: 1px solid var(--border-soft);
}
.login-box form > button {
  justify-content: space-between;
  padding: 11px 16px;
}
.skip-link {
  position: fixed;
  top: -80px;
  left: 20px;
  z-index: 100;
  background: var(--accent);
  color: #fff;
  padding: 12px 20px;
  border-radius: 8px;
}
.skip-link:focus {
  top: 12px;
}
.log-tools {
  margin-bottom: 18px;
}
#callsBody td:last-child {
  font:
    10px/1.6 ui-monospace,
    Consolas,
    monospace;
  min-width: 130px;
}
#callsBody td:nth-child(5) {
  min-width: 140px;
}
#quotaOverviewState {
  font-size: 12px;
}
#modelsResult {
  min-height: 80px;
}
[hidden] {
  display: none !important;
}
#statsSummary {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 14px 0 20px;
  gap: 10px;
}
#statsSummary .metric {
  position: relative;
  background: #fff;
  padding: 14px 16px;
  border: 1px solid var(--border);
}
#statsSummary .metric:nth-child(2) {
  border-color: var(--border);
  background: #fff;
}
#statsSummary .metric:nth-child(2) strong {
  color: var(--accent);
}
#statsSummary .metric:nth-child(4) {
  border-color: var(--border);
  background: #fff;
}
#statsSummary .metric:nth-child(4) strong {
  color: var(--ink);
}
.analytics-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 14px;
  margin: 0;
  align-items: stretch;
}
.analytics-chart {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #fff;
}
.trend-panel {
  grid-column: auto;
}
.chart-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.chart-heading h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.chart-heading small {
  font-size: 10px;
}
.chart-legend {
  display: flex;
  gap: 9px;
  font-size: 10px;
  white-space: nowrap;
}
.chart-legend span:before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 2px;
  background: currentColor;
}
.success,
.healthy {
  color: #159775;
}
.failure,
.empty {
  color: #d04e62;
}
.cancelled,
.unknown {
  color: #8993a7;
}
.low {
  color: #bd800e;
}
.trend-chart {
  display: flex;
  gap: 12px;
  align-items: end;
  min-height: 174px;
  overflow-x: auto;
  padding: 12px 4px 0;
  background: repeating-linear-gradient(
    to top,
    transparent 0,
    transparent 46px,
    #f0f3f8 47px,
    #f0f3f8 48px
  );
  border-bottom: 1px solid var(--border-soft);
}
.trend-column {
  flex: 1 0 30px;
  max-width: 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: end;
  gap: 7px;
  height: 184px;
  outline-offset: 3px;
  border-radius: 5px;
}
.trend-column strong {
  font-size: 10px;
  color: var(--text-secondary);
  font-weight: 500;
}
.trend-column small {
  font-size: 10px;
  white-space: nowrap;
  color: var(--muted);
}
.trend-stack {
  display: flex;
  flex-direction: column-reverse;
  justify-content: start;
  width: min(100%, 36px);
  border-radius: 3px 3px 0 0;
  overflow: hidden;
  background: #eef1f7;
  max-width: 34px;
}
.trend-stack span {
  width: 100%;
  flex-shrink: 0;
}
.trend-stack .success {
  background: #4dba96;
}
.trend-stack .failure {
  background: #e27b81;
}
.trend-stack .cancelled {
  background: #bdc5d4;
}
.ranking-row,
.ranking-row.metric-link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px;
  margin: 6px 0;
  padding: 6px 0;
}
.ranking-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-secondary);
}
.ranking-name > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-number {
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.ranking-row > strong {
  font-size: 11px;
  color: var(--ink);
  font-weight: 500;
}
.rank-track {
  grid-column: 1/-1;
  margin-left: 25px;
  height: 3px;
  background: #f0f3f2;
  border-radius: 2px;
  overflow: hidden;
}
.rank-track span {
  display: block;
  height: 100%;
  background: #6a9e8d;
  border-radius: 6px;
}
#statsAccountRank .rank-track span {
  background: #6a9e8d;
}
#statsKeyRank .rank-track span {
  background: #8b98ae;
}
a.ranking-row {
  color: inherit;
  border-radius: 5px;
}
a.ranking-row:hover {
  background: #f5f7fc;
  text-decoration: none;
}
.data-note {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.stats-details {
  margin-top: 18px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.stats-details > summary {
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  color: var(--text-secondary);
}
.stats-details > summary small {
  font-weight: 400;
  margin-left: 8px;
}
.quota-query-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.quota-query-options label {
  margin: 0;
}
.quota-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 20px 0 16px;
}
.pill {
  display: inline-block;
  font-size: 10px;
  font-weight: 550;
  line-height: 1.7;
  padding: 3px 8px;
  border-radius: 5px;
  white-space: nowrap;
  background: #f0f3f7;
}
.pill.healthy {
  background: #eaf8f2;
}
.pill.low {
  background: #fff6df;
}
.pill.empty {
  background: #fff0f2;
}
.pill.unknown {
  background: #f0f2f6;
}
.quota-model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.quota-model-card {
  min-width: 0;
  border: 1px solid #e3e9f3;
  border-radius: 7px;
  padding: 16px;
  background: #fff;
  border-color: var(--border);
}
.quota-card-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
}
.quota-card-heading h3 {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.quota-card-heading .pill {
  flex-shrink: 0;
}
.quota-balance {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 15px 0 10px;
}
.quota-balance > strong {
  font-size: 28px;
  line-height: 1;
  letter-spacing: -1px;
  color: #293e62;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.quota-balance > span {
  font-size: 11px;
  color: #93a0b4;
}
.balance-track {
  height: 7px;
  border-radius: 8px;
  background: #edf1f6;
  overflow: hidden;
}
.balance-track > span {
  display: block;
  height: 100%;
  border-radius: 8px;
  background: #4dba96;
}
.balance-track.low > span {
  background: #e2ac3e;
}
.balance-track.empty {
  background: #fae4e9;
}
.balance-track.unknown {
  background: repeating-linear-gradient(135deg, #f2f4f8, #f2f4f8 5px, #e8ecf3 5px, #e8ecf3 10px);
}
.quota-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #8a98ac;
  font-size: 11px;
  margin-top: 10px;
}
.quota-breakdown {
  border-top: 1px solid #edf0f6;
  margin-top: 17px;
  padding-top: 12px;
}
.quota-breakdown > summary {
  font-size: 11px;
  color: #687fb1;
  cursor: pointer;
}
.quota-account-list {
  max-height: 280px;
  overflow: auto;
  margin-top: 8px;
}
.quota-account-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 80px;
  gap: 8px 12px;
  padding: 12px 0;
  border-bottom: 1px solid #eef1f6;
}
.quota-account-line strong {
  font-size: 11px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.quota-account-line > div:first-child > small {
  display: block;
  font-size: 10px;
}
.quota-account-line > small {
  grid-column: 1/-1;
  font-size: 10px;
}
.quota-line-balance {
  text-align: right;
}
.quota-line-balance > .balance-track {
  margin-top: 6px;
  height: 4px;
}
.quota-account-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.quota-account-card {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 15px;
  border-color: var(--border);
}
.quota-account-card > summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 12px;
}
.quota-account-card > summary:before {
  content: "+";
  color: #92a1bb;
  font-size: 16px;
}
.quota-account-card[open] > summary:before {
  content: "−";
}
.quota-account-card > summary strong {
  flex: 1;
  overflow-wrap: anywhere;
  font-weight: 500;
}
.quota-account-card[open] > summary {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.quota-account-card[open] {
  max-height: 420px;
  overflow: auto;
}
.error-message {
  color: #c65269;
  font-size: 12px;
  overflow-wrap: anywhere;
  margin: 12px 0 0;
}
.account-model-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid #eff2f7;
}
.account-model-line strong,
.account-model-line span {
  font-size: 11px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.account-model-line > .balance-track,
.account-model-line > small {
  grid-column: 1/-1;
}
.account-model-line > small {
  font-size: 10px;
}
.quota-model-grid > .empty-state,
.quota-account-grid > .empty-state {
  grid-column: 1/-1;
  padding: 50px 20px;
  background: var(--surface-muted);
  border: 1px dashed #dde4ef;
  border-radius: 10px;
}
.endpoint small {
  display: block;
  margin-top: 4px;
  font-size: 11px;
}
.endpoint-disabled {
  background: #fafbfc;
}
.endpoint-disabled code,
.endpoint-disabled span,
.endpoint-disabled small {
  color: #9ca5b3;
}
.endpoint-disabled button {
  color: #a5adba;
  background: #f2f4f7;
  border-color: #e6e9ee;
  opacity: 1;
}
.endpoint-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.endpoint-group {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
  padding: 0 14px;
}
.endpoint-group-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--border);
  padding: 13px 0;
}
.endpoint-group-heading h3 {
  margin: 0;
  font-size: 14px;
}
.endpoint-group .endpoint {
  padding: 12px 0;
  gap: 10px;
}
.endpoint-group .endpoint > div {
  min-width: 0;
}
.endpoint-group .endpoint span {
  font-size: 12px;
  margin-bottom: 2px;
  color: #53647e;
}
.endpoint-group .endpoint small {
  font-size: 10px;
  margin: 0 0 6px;
  color: #8a96a8;
}
.endpoint-group .endpoint code {
  font-size: 11px;
}
.endpoint-group .endpoint-disabled {
  background: transparent;
}
.endpoint-group.is-unavailable {
  background: #fafbfc;
}
.endpoint-group.is-unavailable .endpoint span,
.endpoint-group.is-unavailable .endpoint code {
  color: #a0a8b5;
}
.endpoint-group .endpoint:last-child {
  border-bottom: 0;
}
.endpoint-group + .data-note {
  margin-top: 12px;
}
.endpoint-group .copy-endpoint {
  flex-shrink: 0;
}
.nav-icon svg {
  width: 16px;
  height: 16px;
}
.workspace-tabs {
  margin-top: 0;
  margin-bottom: 20px;
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 0;
  gap: 18px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
.workspace-tabs .tab {
  border-radius: 0;
  border: 0;
  white-space: nowrap;
  padding: 10px 2px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  font-size: 12px;
  min-height: 38px;
  box-shadow: none;
}
.workspace-tabs .tab[aria-selected="true"] {
  background: transparent;
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.workspace-tabs .tab:focus-visible {
  outline-offset: -2px;
}
.metric-link {
  display: block;
  color: inherit;
  text-decoration: none;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.metric-link:hover {
  background: var(--surface-muted);
  border-color: #b5cfc3;
  text-decoration: none;
}
.metric-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.key-editors {
  align-items: start;
  gap: 12px;
  margin-bottom: 4px;
}
.key-editor.card {
  padding: 0;
}
.key-editor > summary {
  padding: 13px 16px;
  margin: 0 !important;
  font-size: 12px;
  color: var(--ink);
}
.key-editor-content {
  padding: 0 16px 16px;
}
#keysBody td:last-child {
  min-width: 260px;
}
#keysBody td:nth-child(2) {
  font-family: ui-monospace, Consolas, monospace;
}
.key-identifier code {
  display: block;
  max-width: 300px;
  font:
    11px/1.6 ui-monospace,
    Consolas,
    monospace;
  overflow-wrap: anywhere;
  word-break: break-all;
  user-select: all;
  background: var(--surface-muted);
  padding: 5px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.key-identifier .key-copy {
  margin-top: 6px;
  padding: 2px 8px;
  min-height: 26px;
  font-size: 11px;
}
.nearby-feedback {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 4px 0;
  color: var(--text-secondary);
}
.nearby-feedback:empty {
  display: none;
}
.nearby-feedback.error {
  color: #bc3545;
}
.nearby-feedback.loading {
  color: var(--muted);
}
.nearby-detail > td {
  background: #f7fbf9;
  padding: 14px 16px;
  border-block: 1px solid #d9e9e1;
}
.nearby-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.nearby-heading strong {
  font-size: 12px;
}
.nearby-heading button {
  padding: 3px 9px;
  min-height: 27px;
  font-size: 11px;
}
.nearby-detail .card {
  padding: 0;
  border: 0;
  box-shadow: none;
  background: transparent;
  margin: 0;
}
.nearby-form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
}
.nearby-form label {
  margin: 0;
  min-width: 180px;
  flex: 1;
}
.nearby-form input {
  display: block;
  width: 100%;
  margin-top: 5px;
}
.nearby-form > button {
  flex: none;
}
.nearby-detail .toolbar {
  margin: 6px 0;
}
.session-label {
  border-left: 1px solid var(--border);
  padding-left: 12px;
  font-size: 11px;
  color: var(--text-secondary);
}
.account-metrics .metric:last-child {
  border-right: 0;
}
.settings-form > input,
.settings-form > select {
  max-width: 460px;
}
.login-box .brand > div > span {
  color: var(--muted);
}
.oidc-login {
  width: 100%;
  min-height: 38px;
  margin-bottom: 10px;
}
#statsSummary .metric:nth-child(5) strong {
  font-size: 17px;
  letter-spacing: -.4px;
}
.section-caption {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  margin: 0 0 9px;
}
.product-label {
  font-size: 10px;
  letter-spacing: 0.6px;
  font-weight: 600;
  color: var(--muted);
}
#performanceDetails {
  margin-top: 20px;
  opacity: 0.8;
}

@media (min-width: 1250px) {
  #statsSummary {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
  .quota-model-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 1100px) {
  :root {
    --sidebar: 190px;
  }
  .main-inner {
    padding: 22px 20px 56px;
  }
  .topbar {
    padding: 0 20px;
  }
  .topbar-actions {
    gap: 8px;
  }
  .runtime-region {
    max-width: 140px;
  }
  .session-label {
    display: none;
  }
  .page-grid {
    grid-template-columns: 1fr;
  }
  .key-editors {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .card-heading {
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .analytics-layout {
    grid-template-columns: 1fr;
  }
  .endpoint-groups {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .scroll > table { min-width: 760px; }
  :root {
    --sidebar: 0px;
  }
  .sidebar {
    position: sticky;
    top: 0;
    width: 100%;
    height: auto;
    padding: 12px 12px 0;
    border-right: 0;
    z-index: 30;
  }
  .sidebar > .brand {
    padding: 0 4px 10px;
    font-size: 15px;
  }
  .brand-mark {
    width: 26px;
    height: 26px;
    border-radius: 7px;
  }
  .brand > div > span {
    display: none;
  }
  nav {
    display: flex;
    gap: 4px;
    padding: 0 0 8px;
    overflow: auto;
  }
  nav a {
    white-space: nowrap;
    margin: 0;
    padding: 7px 10px;
    min-height: 32px;
    font-size: 11px;
  }
  nav a[aria-current="page"] {
    box-shadow: none;
    background: #2c3e39;
  }
  .nav-label,
  .sidebar-footer {
    display: none;
  }
  .nav-icon {
    width: 14px;
    height: 14px;
  }
  .nav-icon svg {
    width: 14px;
    height: 14px;
  }
  main {
    margin-left: 0;
  }
  .topbar {
    position: static;
    height: 44px;
    padding: 0 14px;
    gap: 8px;
  }
  .topbar-actions {
    gap: 6px;
  }
  .runtime-region {
    max-width: 120px;
    font-size: 9px;
  }
  .topbar button {
    font-size: 10px;
    padding: 3px 7px;
    min-height: 26px;
  }
  .product-label {
    font-size: 9px;
  }
  .main-inner {
    padding: 20px 12px 62px;
  }
  .page-heading {
    margin-bottom: 16px;
  }
  .page-heading h1 {
    font-size: 21px;
  }
  .page-heading p {
    font-size: 11px;
    line-height: 1.7;
  }
  .page-version {
    display: none;
  }
  .card {
    padding: 15px 13px;
    border-radius: 7px;
    margin-bottom: 12px;
  }
  .card-heading {
    gap: 10px;
    margin-bottom: 12px;
  }
  .card-heading p {
    font-size: 11px;
  }
  .account-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    overflow: visible;
    gap: 0;
  }
  .account-metrics .metric {
    padding: 11px 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .account-metrics .metric strong {
    font-size: 21px;
  }
  .metrics,
  #statsSummary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .metric,
  #statsSummary .metric {
    padding: 12px;
  }
  .metric strong {
    font-size: 23px;
  }
  .filters label {
    min-width: 120px;
    flex-basis: calc(50% - 10px);
  }
  .filters label:first-child {
    max-width: none;
  }
  .filters input,
  .filters select {
    width: 100%;
    min-width: 0;
  }
  .toolbar {
    width: 100%;
    gap: 5px;
  }
  .toolbar button,
  .toolbar .button {
    font-size: 11px;
    padding: 5px 8px;
  }
  .workspace-tabs {
    gap: 14px;
    margin-bottom: 15px;
  }
  .workspace-tabs .tab {
    padding: 9px 1px;
    font-size: 11px;
  }
  .key-editors,
  .quota-model-grid,
  .quota-account-grid,
  .page-grid {
    grid-template-columns: 1fr;
  }
  .key-editors {
    gap: 0;
  }
  .settings-form > input,
  .settings-form > select {
    max-width: 100%;
  }
  .analytics-chart {
    padding: 13px;
  }
  .chart-heading {
    flex-wrap: wrap;
    gap: 8px;
  }
  .chart-legend {
    font-size: 9px;
  }
  .trend-chart {
    gap: 6px;
  }
  .quota-card-heading {
    flex-wrap: wrap;
  }
  .quota-model-card {
    padding: 14px;
  }
  .quota-balance > strong {
    font-size: 26px;
  }
  .endpoint {
    gap: 10px;
  }
  .endpoint code {
    font-size: 10px;
  }
  .pagination {
    align-items: flex-start;
    gap: 8px;
  }
  .pagination button {
    font-size: 10px;
    padding: 4px 8px;
  }
  td,
  th {
    padding: 9px 10px;
  }
  .status-bar {
    left: 0;
    padding: 7px 12px;
    font-size: 10px;
  }
  .nearby-form label {
    min-width: 100%;
  }
  .nearby-heading {
    align-items: flex-start;
  }
  .nearby-heading strong {
    overflow-wrap: anywhere;
  }
  .login-box {
    padding: 26px;
    max-width: 360px;
  }
  .login-box .brand {
    font-size: 17px;
  }
  .login-box .brand > div > span {
    display: block;
  }
  .quota-query-options .data-note {
    max-width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
    transition: none !important;
  }
}
@media (forced-colors: active) {
  nav a[aria-current="page"],
  .tab[aria-selected="true"] {
    outline: 1px solid Highlight;
  }
  .connection-dot {
    background: CanvasText;
  }
}
`;
