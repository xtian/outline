/**
 * Normalizes the raw value of an OIDC group claim into a stable list of group
 * identifiers. Providers report group membership in a variety of shapes: a
 * single string, an array of strings, or an array of objects (eg Azure AD /
 * ADFS sometimes emit `{ id, value, name }`). The result is trimmed of empty
 * values, deduplicated, and sorted so that downstream landing-team selection is
 * deterministic across logins.
 *
 * Comma-delimited strings are intentionally NOT split, as group names may
 * legitimately contain commas.
 *
 * @param raw - the raw claim value read from the profile or id_token.
 * @returns a sorted, deduplicated list of group identifiers.
 */
export function normalizeGroups(raw: unknown): string[] {
  const collected: string[] = [];

  const push = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        collected.push(trimmed);
      }
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as { id?: unknown; value?: unknown; name?: unknown };
      const identifier = obj.id ?? obj.value ?? obj.name;
      if (typeof identifier === "string") {
        const trimmed = identifier.trim();
        if (trimmed) {
          collected.push(trimmed);
        }
      }
    }
  };

  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else {
    push(raw);
  }

  return Array.from(new Set(collected)).sort();
}
