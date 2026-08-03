import { initBotId } from "botid/client/core";

/**
 * Registers a client-side challenge for every kind the proxy route serves.
 *
 * `token`, `device` and `revoke` are OAuth protocol endpoints that are POST-only
 * by spec (RFC 6749 §3.2, RFC 8628 §3.1, RFC 7009 §2.1), so the method is pinned
 * there. `upstream` forwards whatever the SDK's own API client sends — GET to
 * list models, POST to run a completion, sometimes more — and `userinfo` is
 * conventionally GET but OIDC does not forbid POST, so both are left open to any
 * method rather than guessing wrong and silently dropping the challenge.
 */
initBotId({
  protect: [
    { method: "POST", path: "/api/token/*" },
    { method: "POST", path: "/api/device/*" },
    { method: "POST", path: "/api/revoke/*" },
    { method: "*", path: "/api/userinfo/*" },
    { method: "*", path: "/api/upstream/*" },
  ],
});
