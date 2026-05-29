export function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    },
    body: JSON.stringify(body)
  };
}

export function methodNotAllowed(allowed) {
  return json(405, { error: "method_not_allowed" }, { allow: allowed.join(", ") });
}

export async function readJson(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    err.publicCode = "invalid_json";
    throw err;
  }
}

export function handleError(error) {
  const statusCode = error.statusCode || 500;
  const code = error.publicCode || (statusCode >= 500 ? "server_error" : "request_error");
  if (statusCode >= 500) console.error(error);
  return json(statusCode, { error: code, message: statusCode >= 500 ? "Server error" : error.message });
}

