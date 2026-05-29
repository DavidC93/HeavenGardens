import { currentUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";

export async function handler(event) {
  try {
    if (event.httpMethod !== "GET") return methodNotAllowed(["GET"]);
    return json(200, { user: await currentUser(event) });
  } catch (error) {
    return handleError(error);
  }
}

