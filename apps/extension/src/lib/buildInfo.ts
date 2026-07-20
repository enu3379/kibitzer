export interface ExtensionBuildInfo {
  builtAt: string | null
  commit: string | null
}

// Injected by build.mjs via esbuild define. tsc --noEmit and node --test run
// the raw source where the identifier does not exist, so guard with typeof.
declare const __KIBITZER_BUILD__: ExtensionBuildInfo

export function extensionBuildInfo(): ExtensionBuildInfo {
  if (typeof __KIBITZER_BUILD__ === "undefined") return { builtAt: null, commit: null }
  return __KIBITZER_BUILD__
}
