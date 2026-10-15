// Talking to the server's ordinary addresses (not the WebSocket), like the web page's postJson:
// groups, invites. Android sends the login cookie along by itself.
import { SERVER } from './config';

// {ok: true, data} with the server's answer, or {ok: false, error} with words to show.
async function request(method, path, body) {
  try {
    const response = await fetch(SERVER + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, data };
    // FastAPI puts the reason in "detail": our own words for HTTPException, a list for a malformed request.
    return { ok: false, error: typeof data.detail === 'string' ? data.detail : 'Something went wrong.' };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Try again in a moment." };
  }
}

export const getJson = (path) => request('GET', path);
export const postJson = (path, body = {}) => request('POST', path, body);
export const deleteJson = (path) => request('DELETE', path);
