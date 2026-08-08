export const PI_APPROVAL_TITLE_PREFIX = "T3_PI_TOOL_APPROVAL:";
export const PI_APPROVAL_ALLOW_ONCE = "Allow once";
export const PI_APPROVAL_ALLOW_SESSION = "Allow for session";
export const PI_APPROVAL_REJECT = "Reject";

export const PI_APPROVAL_EXTENSION_SOURCE = `
const TITLE_PREFIX = ${JSON.stringify(PI_APPROVAL_TITLE_PREFIX)};
const ALLOW_ONCE = ${JSON.stringify(PI_APPROVAL_ALLOW_ONCE)};
const ALLOW_SESSION = ${JSON.stringify(PI_APPROVAL_ALLOW_SESSION)};
const REJECT = ${JSON.stringify(PI_APPROVAL_REJECT)};

export default function t3PiApprovalExtension(pi) {
  const allowedForSession = new Set();

  pi.on("tool_call", async (event, ctx) => {
    if (process.env.T3_PI_APPROVAL_MODE === "full-access") return undefined;
    if (allowedForSession.has(event.toolName)) return undefined;

    const title = TITLE_PREFIX + JSON.stringify({
      toolName: event.toolName,
      input: event.input,
    });
    const choice = await ctx.ui.select(title, [ALLOW_ONCE, ALLOW_SESSION, REJECT]);
    if (choice === ALLOW_SESSION) {
      allowedForSession.add(event.toolName);
      return undefined;
    }
    if (choice === ALLOW_ONCE) return undefined;
    return { block: true, reason: "Blocked by T3 Code approval policy." };
  });
}
`.trimStart();
