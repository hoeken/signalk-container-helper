// Browser-side entry (`signalk-container-helper/ui`) for Signal K plugin
// config panels. Requires `react` (a peer dependency); everything here is
// compiled to plain React.createElement JS so plugin webpack builds that
// exclude node_modules from babel-loader can bundle it directly.

export { panelStyles, stateColors } from "./styles.js";
export type { StateKind } from "./styles.js";

export {
  deriveVersionsView,
  splitVersions,
  shownTags,
  runningTagFallback,
} from "./versions.js";
export type {
  VersionInfo,
  VersionsResponse,
  VersionsView,
  VersionSourceState,
  SplitVersionsOptions,
} from "./versions.js";

export { formatNumber, formatTimeAgo, formatUpdateMessage } from "./format.js";

export { useStatusPoll, useVersions, useUpdateFlow } from "./hooks.js";
export type {
  StatusPollOptions,
  StatusPoll,
  VersionsState,
  UpdateFlow,
  ApplyResult,
} from "./hooks.js";

export {
  SectionTitle,
  Hint,
  FieldRow,
  StateDot,
  StatusCard,
  CollapsibleSection,
  Button,
  ActionStatus,
  VersionSelect,
  UpdateControls,
} from "./components.js";
export type {
  StatusCardProps,
  ButtonVariant,
  FloatingOption,
  VersionSelectProps,
  UpdateControlsProps,
} from "./components.js";

// Re-exported so panel code can type update responses without importing
// the Node-only main entry.
export type { UpdateCheckResult, UpdateReason, TagKind } from "../types.js";
