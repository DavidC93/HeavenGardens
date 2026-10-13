import { db } from "./_lib/db.mjs";
import { currentUser } from "./_lib/auth.mjs";
import { userWithProviders } from "./_lib/accounts.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";

export async function handler(event) {
  try {
    if (event.httpMethod !== "GET") return methodNotAllowed(["GET"]);
    const user = await currentUser(event);
    return json(200, { user: user ? await userWithProviders(db(), user.id) : null });
  } catch (error) {
    return handleError(error);
  }
}

