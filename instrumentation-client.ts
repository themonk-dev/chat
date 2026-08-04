import { initBotId } from "botid/client/core";

/**
 * The three OAuth endpoints are POST-only by spec; `upstream` and `userinfo`
 * are left open to any method rather than silently dropping the challenge.
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
