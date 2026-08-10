import type { CSSProperties } from "react";

/**
 * The shared inline-style vocabulary of the reference config panels
 * (signalk-grafana, signalk-questdb, mayara-server-signalk-plugin). Every
 * panel hand-copied this object; exporting it keeps the plugins visually
 * consistent and lets a panel spread-extend any entry
 * (`{ ...panelStyles.input, width: 300 }`).
 *
 * Inline styles are deliberate: config panels are Module Federation remotes
 * inside the Signal K Admin UI, and a CSS file shipped by a remote would
 * leak into (or be clobbered by) the host page. Inline styles are the only
 * isolation the panels get.
 */
export const panelStyles = {
  root: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    padding: "16px 0",
  },
  // Chrome for a CollapsibleSection's header button. Spread OVER
  // sectionTitle, so the `color` here deliberately overrides that block's
  // #888: a collapsed section hides real settings, and at #888 the header
  // reads as a muted caption rather than something to click. A signalk-questdb
  // user reported its path-filter field as uneditable when it was only
  // collapsed (dirkwa/signalk-questdb#123). #555 is the same colour as
  // `label`, i.e. the panel's "this is an actual control" tone.
  sectionToggle: {
    color: "#555",
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    userSelect: "none",
  },
  // The ▶ disclosure triangle. `transform` stays at the call site because it
  // is derived from open/closed state.
  sectionMarker: { fontSize: 11, transition: "transform 0.15s" },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 10,
    marginTop: 24,
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnPrimary: { background: "#3b82f6", color: "#fff" },
  btnSecondary: {
    background: "#f1f5f9",
    color: "#475569",
    border: "1px solid #e2e8f0",
  },
  btnWarn: { background: "#f59e0b", color: "#fff" },
  btnDanger: { background: "#ef4444", color: "#fff" },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },
  btnSmall: { padding: "4px 12px", fontSize: 12 },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  card: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "14px 18px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    marginBottom: 12,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    fontWeight: 700,
    flexShrink: 0,
  },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: "#333" },
  cardMeta: { fontSize: 12, color: "#888" },
  stateIndicator: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "#555",
    width: 180,
    flexShrink: 0,
  },
  select: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    minWidth: 200,
  },
  input: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    width: 200,
  },
  inputSmall: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    width: 80,
  },
  checkbox: { width: 16, height: 16, accentColor: "#3b82f6" },
  hint: { fontSize: 11, color: "#aaa", marginLeft: 8 },
  link: {
    color: "#3b82f6",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 600,
  },
  textarea: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    fontFamily: "monospace",
    background: "#fff",
    color: "#333",
    width: "100%",
    minHeight: 70,
    boxSizing: "border-box",
    resize: "vertical",
  },
  empty: {
    textAlign: "center",
    padding: "30px 16px",
    color: "#999",
    fontSize: 13,
  },
  tag: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    marginLeft: 8,
  },
  tagPre: { background: "#fef3c7", color: "#92400e" },
  tagLatest: { background: "#dcfce7", color: "#166534" },
  warnBanner: {
    padding: "12px 16px",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 10,
    marginBottom: 12,
    fontSize: 13,
    color: "#991b1b",
    lineHeight: 1.5,
  },
  warnBannerTitle: { fontWeight: 700, marginBottom: 4 },
  infoBanner: {
    padding: "12px 16px",
    background: "#fffbeb",
    border: "1px solid #fde68a",
    borderRadius: 10,
    marginBottom: 12,
    fontSize: 13,
    color: "#92400e",
    lineHeight: 1.5,
  },
  bannerCode: {
    display: "block",
    marginTop: 8,
    padding: "8px 10px",
    background: "#fff",
    border: "1px solid #fecaca",
    borderRadius: 6,
    fontFamily: "monospace",
    fontSize: 12,
    color: "#7f1d1d",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 10,
    marginBottom: 12,
  },
  statCard: {
    padding: "12px 16px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    textAlign: "center",
  },
  statValue: { fontSize: 22, fontWeight: 700, color: "#333" },
  statLabel: { fontSize: 11, color: "#888", marginTop: 2 },
} satisfies Record<string, CSSProperties>;

/** State-dot / accent colors shared by the panels. */
export const stateColors = {
  ok: "#10b981",
  warn: "#f59e0b",
  error: "#ef4444",
} as const;

export type StateKind = keyof typeof stateColors;
