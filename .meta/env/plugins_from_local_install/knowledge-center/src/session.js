export function resolveSessionKey(event, ctx) {
  return ctx?.sessionKey ?? event?.sessionKey ?? "";
}
