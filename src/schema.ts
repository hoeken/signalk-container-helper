// The config-form half of the managed/self-hosted switch.
//
// Emits PLAIN JSON Schema, deliberately not TypeBox types.
//
// Consumer plugins are split across two mutually incompatible packages —
// `typebox` 1.x and `@sinclair/typebox` 0.34 — and this library has no runtime
// dependencies, so it can depend on neither. Plain fragments are the one shape
// both accept.
//
// That split is PERMANENT, not a migration anyone has yet to finish:
// `@signalk/server-api` itself depends on `@sinclair/typebox` 0.34, so the
// scoped package is in every consumer's tree no matter which one the plugin
// picks for its own schema. Moving a plugin to `typebox` 1.x adds a second
// TypeBox beside the first; it does not remove one. Emitting plain JSON Schema
// is what keeps this module out of that argument entirely.
//
// Splice a fragment in with `Type.Unsafe`, written identically in both:
//
//   managedContainer: Type.Unsafe<boolean>(MODE.managedContainer),
//   externalUrl:      Type.Unsafe<string>(MODE.externalUrl),
//
// A bare fragment spread directly into `Type.Object({...})` compiles under
// typebox 1.x and FAILS under @sinclair/typebox 0.34 ("missing the following
// properties from type 'TSchema': params, static, [Kind]"), so the
// `Type.Unsafe` wrapper is not optional.
//
// `Type.Unsafe` emits the same keys and values as `Type.Boolean`/`Type.String`
// but in a different ORDER (`type` first rather than last). JSON Schema and
// RJSF both ignore key order; compare with sorted keys if you assert on the
// emitted schema while migrating a plugin.

/** A JSON Schema fragment: plain data, safe to `JSON.stringify`. */
export interface JsonSchemaFragment {
  readonly type: string;
  readonly default?: unknown;
  readonly title?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface ManagedModeSchemaOptions<U extends string = "externalUrl"> {
  /** Product noun used in every string, e.g. "backup-server", "QuestDB". */
  productName: string;
  /**
   * Full image ref named in the managed-mode description, e.g.
   * "ghcr.io/dirkwa/signalk-backup-server". Omitted from the copy when absent.
   */
  image?: string;
  /** Example shown in the URL field, e.g. "http://192.168.1.50:3010". */
  exampleUrl?: string;
  /** Property name of the URL field. Default "externalUrl". */
  urlFieldName?: U;
  /** Title override for the URL field. */
  urlTitle?: string;
  /** Default for the toggle. Default true. */
  defaultManaged?: boolean;
}

export interface ManagedModeSchema<U extends string = "externalUrl"> {
  managedContainer: JsonSchemaFragment;
  externalUrl: JsonSchemaFragment;
  /**
   * Runtime defaults for both fields, keyed by their property names.
   *
   * Signal K uses a schema's `default` only to seed the form, never to seed
   * the config a plugin receives, so every consumer hand-writes a
   * SCHEMA_DEFAULTS object beside its schema. Spreading this instead keeps the
   * two derived from the same literals, which is where the drift was.
   */
  defaults: { managedContainer: boolean } & { [K in U]: string };
  /**
   * JSON Schema `dependencies` that render the URL field ONLY while the
   * container is not managed. Splice it in beside `properties`:
   *
   *   export const ConfigSchema = Type.Object({ … }, {
   *     dependencies: managedModeSchema({ … }).dependencies,
   *   })
   *
   * Live-reactive: RJSF re-evaluates dependencies on every change, so the
   * field appears the moment the toggle is switched off. `ui:disabled` cannot
   * do this — a plugin's uiSchema is fetched once when the form loads, so a
   * greyed-out field would stay greyed until a page reload.
   *
   * Optional. A consumer that wants the field always visible just omits this.
   */
  dependencies: Record<string, unknown>;
}

/**
 * Build the managed/self-hosted config fields for one plugin.
 *
 * The switch means "is this container's lifecycle mine, or is the service
 * hosted somewhere else" — NOT "is there a container engine on another
 * machine". signalk-container drives local unix sockets only.
 */
export function managedModeSchema<U extends string = "externalUrl">(
  options: ManagedModeSchemaOptions<U>,
): ManagedModeSchema<U> {
  const {
    productName,
    image,
    exampleUrl,
    urlFieldName = "externalUrl" as U,
    urlTitle,
    defaultManaged = true,
  } = options;

  const title = urlTitle ?? `External ${productName} URL`;
  const runs = image
    ? `the plugin pulls and runs ${image}`
    : `the plugin runs ${productName} in a managed container`;

  const managedContainer: JsonSchemaFragment = {
    type: "boolean",
    default: defaultManaged,
    title: `Manage ${productName} container via signalk-container`,
    description:
      `When enabled${defaultManaged ? " (default)" : ""}, ${runs}. ` +
      `Disable to point at an external ${productName} instance via "${title}".`,
  };

  const externalUrl: JsonSchemaFragment = {
    type: "string",
    default: "",
    title,
    // States plainly that traffic leaves the host: most of these services
    // have no authentication and assume a trusted LAN.
    description:
      `Used only when managedContainer is disabled` +
      (exampleUrl ? `. e.g. ${exampleUrl}` : "") +
      `. Leave blank when managing the container. ` +
      `Traffic to this address leaves this host — use an address you trust.`,
  };

  // `oneOf` on the toggle's own value: the true branch adds nothing, the
  // false branch contributes the URL field. Repeating `managedContainer` in
  // each branch is what keys the choice — RJSF matches the branch whose
  // const equals the current value.
  const dependencies = {
    managedContainer: {
      oneOf: [
        { properties: { managedContainer: { const: true } } },
        {
          properties: {
            managedContainer: { const: false },
            [urlFieldName]: externalUrl,
          },
        },
      ],
    },
  };

  return {
    managedContainer,
    externalUrl,
    dependencies,
    // Cast: TS cannot see that a computed key of type U satisfies
    // `{ [K in U]: string }` when U is generic. The value is correct by
    // construction — urlFieldName IS the key, and its default IS "".
    defaults: {
      managedContainer: defaultManaged,
      [urlFieldName]: "",
    } as { managedContainer: boolean } & { [K in U]: string },
  };
}
