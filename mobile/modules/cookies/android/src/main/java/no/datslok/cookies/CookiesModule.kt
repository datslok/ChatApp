// Reading the login cookie, for the one thing that can't send it by itself: the video player.
//
// When we log in, the server answers with a cookie, and React Native keeps it in Android's
// CookieManager, which sends it along with every request it makes (fetch, <Image>). But expo-video's
// player downloads with its own HTTP client, which knows nothing about it, so the server would answer
// "not found". The player does take extra headers, though, so we hand it the cookie ourselves.
// JavaScript can't read the cookie itself: it's "HttpOnly", which keeps scripts away from it, but
// the CookieManager can.
package no.datslok.cookies

import android.webkit.CookieManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CookiesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Cookies")

    // The cookies for this address, as a Cookie header would carry them ("session=abc; other=xyz"),
    // or null if there are none. A Function (not an AsyncFunction): it answers at once.
    Function("get") { url: String ->
      CookieManager.getInstance().getCookie(url)
    }
  }
}
