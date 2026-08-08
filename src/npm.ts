/** Parse name@version / @scope/name@version into parts. */
export function splitPackageSpec(spec: string): {
  name: string;
  version: string | undefined;
} {
  if (spec.startsWith("@")) {
    const m = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
    if (!m?.[1]) return { name: spec, version: undefined };
    return { name: m[1], version: m[2] };
  }
  const at = spec.indexOf("@");
  if (at <= 0) return { name: spec, version: undefined };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export type NpmLatestResult =
  | { ok: true; name: string; latest: string }
  | { ok: false; name: string; error: string };

export async function fetchNpmLatest(
  name: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NpmLatestResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        name,
        error: `npm registry HTTP ${res.status} for ${name}`,
      };
    }
    const body = (await res.json()) as { version?: string };
    if (!body.version) {
      return { ok: false, name, error: `No version in npm latest for ${name}` };
    }
    return { ok: true, name, latest: body.version };
  } catch (err) {
    return {
      ok: false,
      name,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Loose semver-ish compare: returns true if pinned differs from latest. */
export function isVersionDrift(pinned: string, latest: string): boolean {
  // Treat dist-tags as drift-prone vs concrete latest
  if (pinned === "latest" || pinned === "next" || pinned === "*") return true;
  return pinned !== latest;
}
