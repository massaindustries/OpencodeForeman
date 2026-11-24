/**
 * OpenCode discovers plugins under `.opencode/plugins/`. The foreman loop lives
 * in `scripts/foreman/plugin.ts` so the whole harness can be synced as one
 * folder; this file only re-exports it.
 */
export * from "../../../scripts/foreman/plugin"
export { default } from "../../../scripts/foreman/plugin"
