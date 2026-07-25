// Presentational building blocks shared by containerized-plugin config
// panels. Shipped as tsc-compiled React.createElement JS (no JSX) because
// the reference panels' webpack configs exclude node_modules from
// babel-loader; `react` resolves to the Admin UI's Module Federation
// shared singleton.

import React, { useState, type CSSProperties, type ReactNode } from "react";
import { panelStyles as S, stateColors, type StateKind } from "./styles.js";
import {
  runningTagFallback,
  splitVersions,
  type SplitVersionsOptions,
  type VersionInfo,
} from "./versions.js";
import { formatUpdateMessage } from "./format.js";
import { useUpdateFlow } from "./hooks.js";

/** Uppercase section heading ("GRAFANA STATUS", "SETTINGS", …). */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={S.sectionTitle}>{children}</div>;
}

/** Small grey inline hint; `color` overrides for warnings. */
export function Hint({
  children,
  color,
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <span style={{ ...S.hint, ...(color ? { color } : {}) }}>{children}</span>
  );
}

/**
 * A labeled settings row: fixed-width label, then the control(s), then an
 * optional hint. The layout every reference panel uses for its form.
 */
export function FieldRow({
  label,
  hint,
  hintColor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  hintColor?: string;
  children?: ReactNode;
}) {
  return (
    <div style={S.fieldRow}>
      <span style={S.label}>{label}</span>
      {children}
      {hint !== undefined && hint !== null && hint !== "" && (
        <Hint color={hintColor}>{hint}</Hint>
      )}
    </div>
  );
}

/** The 10px status dot: green ok / amber warn / red error, or a custom color. */
export function StateDot({
  state = "ok",
  color,
  title,
  style,
}: {
  state?: StateKind;
  color?: string;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        ...S.stateIndicator,
        background: color ?? stateColors[state],
        ...style,
      }}
      title={title}
    />
  );
}

export interface StatusCardProps {
  /** Icon glyph, typically one or two letters ("G", "Q", "SK"). */
  icon: ReactNode;
  iconBackground?: string;
  iconColor?: string;
  title: ReactNode;
  /** Secondary line: version, address, counts… */
  meta?: ReactNode;
  /** Drives the state dot (and the default icon colors when omitted). */
  state?: StateKind;
  stateTitle?: string;
  /** Optional "Open Grafana ↗"-style external link. */
  link?: { href: string; label: ReactNode };
  /** Extra elements between the info block and the state dot. */
  children?: ReactNode;
}

/**
 * The container status card: icon, name, meta line, optional link, state
 * dot. In the error state the icon flips to the shared muted-red treatment
 * unless explicit colors are given.
 */
export function StatusCard({
  icon,
  iconBackground,
  iconColor,
  title,
  meta,
  state = "ok",
  stateTitle,
  link,
  children,
}: StatusCardProps) {
  const errorIcon = state === "error" && !iconBackground;
  return (
    <div style={S.card}>
      <div
        style={{
          ...S.cardIcon,
          background: errorIcon ? "#fef2f2" : (iconBackground ?? "#3b82f6"),
          color: errorIcon ? stateColors.error : (iconColor ?? "#fff"),
        }}
      >
        {icon}
      </div>
      <div style={S.cardInfo}>
        <div style={S.cardTitle}>{title}</div>
        {meta !== undefined && meta !== null && (
          <div style={S.cardMeta}>{meta}</div>
        )}
      </div>
      {children}
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          style={S.link}
        >
          {link.label}
        </a>
      )}
      <StateDot state={state} title={stateTitle} />
    </div>
  );
}

/**
 * Collapsed-by-default section for advanced/rare settings. A real <button>
 * so keyboard users can toggle with Enter/Space and screen readers announce
 * expanded state; the style resets the default button chrome so it still
 * reads as a section title.
 */
export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        style={{
          ...S.sectionTitle,
          cursor: "pointer",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          padding: 0,
        }}
        onClick={() => setOpen(!open)}
      >
        <span
          style={{
            fontSize: 10,
            transition: "transform 0.15s",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          {"▶"}
        </span>
        {title}
      </button>
      {open && <div style={{ marginBottom: 16 }}>{children}</div>}
    </div>
  );
}

export type ButtonVariant = "primary" | "secondary" | "warn" | "danger";

const VARIANT_STYLES: Record<ButtonVariant, CSSProperties> = {
  primary: S.btnPrimary,
  secondary: S.btnSecondary,
  warn: S.btnWarn,
  danger: S.btnDanger,
};

/**
 * Panel button. `busy` renders `busyLabel` and disables — the
 * "Updating…" / "Checking…" pattern.
 */
export function Button({
  variant = "primary",
  small = false,
  busy = false,
  busyLabel,
  disabled = false,
  onClick,
  title,
  style,
  children,
}: {
  variant?: ButtonVariant;
  small?: boolean;
  busy?: boolean;
  busyLabel?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const isDisabled = disabled || busy;
  return (
    <button
      type="button"
      style={{
        ...S.btn,
        ...VARIANT_STYLES[variant],
        ...(small ? S.btnSmall : {}),
        ...(isDisabled ? S.btnDisabled : {}),
        ...style,
      }}
      onClick={onClick}
      disabled={isDisabled}
      title={title}
    >
      {busy ? (busyLabel ?? children) : children}
    </button>
  );
}

/**
 * The action-outcome line under the form: green for success, red for
 * failure. Renders (with reserved height) only when `message` is set.
 */
export function ActionStatus({
  message,
  error = false,
  style,
}: {
  message: string;
  error?: boolean;
  style?: CSSProperties;
}) {
  if (!message) return null;
  return (
    <div
      style={{
        ...S.status,
        color: error ? stateColors.error : stateColors.ok,
        marginTop: 16,
        ...style,
      }}
    >
      {message}
    </div>
  );
}

export interface FloatingOption {
  tag: string;
  /** Display label; defaults to the tag. */
  label?: string;
}

export interface VersionSelectProps extends SplitVersionsOptions {
  value: string;
  onChange: (tag: string) => void;
  /** From `useVersions` / your /api/versions endpoint. */
  versions: VersionInfo[];
  /**
   * Non-release tags listed first. Default
   * `[{ tag: "latest", label: "latest (recommended)" }]`.
   */
  floatingOptions?: FloatingOption[];
  loading?: boolean;
  /** Operator-facing fetch error (from `useVersions`); rendered in red. */
  error?: string;
  /** When set, renders the ↻ refresh button. */
  onRefresh?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
}

const DEFAULT_FLOATING: FloatingOption[] = [
  { tag: "latest", label: "latest (recommended)" },
];

/**
 * The image-version dropdown: floating tags, then pre-releases, then stable
 * releases ("(current stable)" on the newest), then PR test images in an
 * optgroup. When the current `value` isn't among the rendered options —
 * e.g. a pr<N> whose listing was rate-limited, or a stable pin that fell
 * out of the top-N — a synthetic "<tag> (running)" option is injected so
 * the controlled <select> never renders blank and silently resets the
 * operator's real running image.
 *
 * Renders inline elements only, so it slots into a `FieldRow`.
 */
export function VersionSelect({
  value,
  onChange,
  versions,
  floatingOptions = DEFAULT_FLOATING,
  stableCount,
  preCount,
  loading = false,
  error,
  onRefresh,
  disabled = false,
  style,
}: VersionSelectProps) {
  const splitOptions = { stableCount, preCount };
  const { prVersions, stableVersions, preVersions } = splitVersions(
    versions,
    splitOptions,
  );
  const fallbackTag = runningTagFallback(
    value,
    versions,
    floatingOptions.map((f) => f.tag),
    splitOptions,
  );
  return (
    <>
      <select
        style={{ ...S.select, ...style }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {floatingOptions.map((f) => (
          <option key={f.tag} value={f.tag}>
            {f.label ?? f.tag}
          </option>
        ))}
        {preVersions.map((v) => (
          <option key={v.tag} value={v.tag}>
            {v.tag} (pre-release)
          </option>
        ))}
        {stableVersions.map((v, i) => (
          <option key={v.tag} value={v.tag}>
            {v.tag}
            {i === 0 ? " (current stable)" : ""}
          </option>
        ))}
        {prVersions.length > 0 && (
          <optgroup label="PR test images">
            {prVersions.map((v) => (
              <option key={v.tag} value={v.tag}>
                {v.tag}
                {v.title ? ` — ${v.title}` : ""}
              </option>
            ))}
          </optgroup>
        )}
        {fallbackTag && (
          <option value={fallbackTag}>{fallbackTag} (running)</option>
        )}
      </select>
      {loading && <Hint>loading releases...</Hint>}
      {onRefresh && (
        <Button
          small
          style={{ padding: "4px 10px", fontSize: 11 }}
          onClick={onRefresh}
          title="Refresh available versions"
        >
          ↻
        </Button>
      )}
      {error && <Hint color={stateColors.error}>{error}</Hint>}
    </>
  );
}

export interface UpdateControlsProps {
  /** GET route mounted by `registerUpdateRoutes` — returns UpdateCheckResult. */
  checkUrl: string;
  /** POST route mounted by `registerUpdateRoutes` — body { tag? }. */
  applyUrl: string;
  /** Tag to apply; omit to re-apply the container's current tag. */
  tag?: string;
  /** Called with the resolved tag after a successful apply. */
  onApplied?: (tag: string | undefined) => void;
  updateLabel?: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}

/**
 * The self-contained check/apply row: a "Check for updates" button that
 * becomes "vX → vY available [Update]" when the check says so, or the
 * up-to-date/offline message otherwise. Talks to the routes
 * `ManagedContainer.registerUpdateRoutes` mounts. For a custom layout use
 * `useUpdateFlow` + `formatUpdateMessage` directly.
 */
export function UpdateControls({
  checkUrl,
  applyUrl,
  tag,
  onApplied,
  updateLabel = "Update",
  disabled = false,
  style,
}: UpdateControlsProps) {
  const flow = useUpdateFlow({ checkUrl, applyUrl });
  const [applied, setApplied] = useState("");

  const doApply = async () => {
    setApplied("");
    const res = await flow.apply(tag);
    if (res.ok) {
      setApplied(res.tag ? `Updated to ${res.tag}.` : "Updated.");
      onApplied?.(res.tag);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
        ...style,
      }}
    >
      {flow.result?.updateAvailable ? (
        <>
          <span style={{ fontSize: 13 }}>
            {formatUpdateMessage(flow.result)}
          </span>
          <Button
            small
            variant="warn"
            busy={flow.applying}
            busyLabel="Updating..."
            disabled={disabled || flow.checking}
            onClick={() => void doApply()}
            title="Pull the image and recreate the container"
          >
            {updateLabel}
          </Button>
        </>
      ) : flow.result ? (
        <span style={{ fontSize: 12, color: "#888" }}>
          {formatUpdateMessage(flow.result)}
        </span>
      ) : (
        <Button
          small
          variant="secondary"
          busy={flow.checking}
          busyLabel="Checking..."
          disabled={disabled || flow.applying}
          onClick={() => void flow.check()}
        >
          Check for updates
        </Button>
      )}
      {applied && (
        <span style={{ fontSize: 12, color: stateColors.ok }}>{applied}</span>
      )}
      {flow.error && (
        <span style={{ fontSize: 12, color: stateColors.error }}>
          {flow.error}
        </span>
      )}
    </div>
  );
}
