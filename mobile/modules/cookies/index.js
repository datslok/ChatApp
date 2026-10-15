// Our own native module (android/.../CookiesModule.kt): the login cookie, for the video player, which
// downloads with an HTTP client of its own that doesn't send it (see the Kotlin file).
import { requireNativeModule } from 'expo';

const Cookies = requireNativeModule('Cookies');

// The cookies for this address, as a Cookie header ("session=abc"), or null.
export function getCookie(url) {
  return Cookies.get(url);
}
