/**
 * Shared provider-neutral T3 guidance.
 *
 * One definition, delivered through each provider's strongest native channel.
 * Content must stay free of provider protocol details (Codex collaboration
 * modes, request_user_input, update_plan, proposed_plan, ...) so it is safe
 * for every channel below.
 *
 * Delivery matrix (issue #6):
 * - Codex: composed into the Codex developer instructions (exactly once).
 * - Claude: appended to the native `claude_code` system prompt preset.
 * - OpenCode: sent through the SDK's native `system` field on promptAsync.
 * - Pi: appended via Pi's native `--append-system-prompt` launch option.
 * - Cursor / Grok / Hermes (ACP): ACP has no system/developer-instruction
 *   field. Guidance is not sent; capability-local guidance stays in the
 *   `t3-code` MCP tool descriptions. Revisit if an ACP channel appears.
 *
 * `hasPreviewTools` gates the collaborative-browser section so no agent is
 * ever told to call `preview_*` tools that were not attached to its session.
 */

export interface T3GuidanceOptions {
  /**
   * True when this session actually exposes the `t3-code` MCP `preview_*`
   * tools. When false the collaborative-browser section is omitted.
   */
  readonly hasPreviewTools: boolean;
}

const T3_RUNTIME_GUIDANCE = `## T3 Code runtime

You are operating inside T3 Code, a collaborative coding environment shared with the user. Follow your provider-native configuration, project instructions, skills, and interaction modes; nothing here replaces them.`;

const T3_PREVIEW_BROWSER_GUIDANCE = `## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.`;

export function buildT3Guidance(options: T3GuidanceOptions): string {
  const sections = [T3_RUNTIME_GUIDANCE];
  if (options.hasPreviewTools) {
    sections.push(T3_PREVIEW_BROWSER_GUIDANCE);
  }
  return sections.join("\n\n");
}
