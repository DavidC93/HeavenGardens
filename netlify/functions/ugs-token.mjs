import { requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";

// Signs the logged-in Heaven Gardens player into Unity Gaming Services with a Custom ID (the account id), so the
// same person has the same Unity identity (online matches, later friends) on every device.
//
// Required Netlify environment variables (set in the Netlify UI, never in the repo):
//   UGS_PROJECT_ID, UGS_ENVIRONMENT_ID, UGS_ENVIRONMENT_NAME (e.g. "production"),
//   UGS_KEY_ID, UGS_SECRET_KEY  (service account with the "Player Authentication Token Issuer" project role)

const env = name => {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`Missing ${name}`);
    err.statusCode = 503;
    err.publicCode = "ugs_not_configured";
    throw err;
  }
  return value;
};

async function statelessToken(projectId, environmentId) {
  const basic = Buffer.from(`${env("UGS_KEY_ID")}:${env("UGS_SECRET_KEY")}`).toString("base64");
  const url = `https://services.api.unity.com/auth/v1/token-exchange?projectId=${encodeURIComponent(projectId)}&environmentId=${encodeURIComponent(environmentId)}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) {
    const err = new Error(`token exchange failed (${res.status})`);
    err.statusCode = 502;
    err.publicCode = "ugs_token_exchange_failed";
    throw err;
  }
  const body = await res.json();
  return body.accessToken;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const user = await requireUser(event);
    const projectId = env("UGS_PROJECT_ID");
    const environmentId = env("UGS_ENVIRONMENT_ID");
    const environmentName = process.env.UGS_ENVIRONMENT_NAME || "production";

    const token = await statelessToken(projectId, environmentId);
    const res = await fetch(`https://player-auth.services.api.unity.com/v1/projects/${encodeURIComponent(projectId)}/authentication/server/custom-id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        UnityEnvironment: environmentName,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ externalId: `hg-${user.id}` })
    });
    if (!res.ok) {
      const err = new Error(`custom id sign-in failed (${res.status})`);
      err.statusCode = 502;
      err.publicCode = "ugs_sign_in_failed";
      throw err;
    }
    const body = await res.json();
    return json(200, {
      idToken: body.idToken,
      sessionToken: body.sessionToken,
      displayName: user.display_name || String(user.email || "").split("@")[0]
    });
  } catch (error) {
    return handleError(error);
  }
}
