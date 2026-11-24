// Minimal local stand-in for the `@opencode/plugin` module so the foreman plugin
// can be type-checked standalone, without installing OpenCode itself.
//
// OpenCode resolves this import at runtime; here we only need the shape the
// plugin actually uses (`Plugin.define`). When the real package is available,
// remove this file and let module resolution find it instead.
declare module "@opencode/plugin" {
  export const Plugin: {
    define: (config: any) => any
  }
}
