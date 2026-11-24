// Minimal stand-in for @opencode/plugin so the plugin module can be bundled and
// driven from node in tests/acceptance-smoke.mjs.
export const Plugin = {
  define: (config: unknown) => config,
}

export default { Plugin }
