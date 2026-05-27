import { useRouter, type Href } from 'expo-router';
import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { deliverPlayerData } from '../../api/playerCache';

const BASE44_URL = 'https://icare-life-learn.base44.app';
const API_KEY = '6af260f41e2140b9950788621360c5cf';
const BASE_API = 'https://icare-life-learn.base44.app/api';

/**
 * Actual Base44 chapter player URL (confirmed from live app inspection):
 *
 *   /chapter/{courseId}/{chapterId}
 *
 * The chapterId is the SECOND path segment.
 */
const CHAPTER_PATH_PATTERNS: RegExp[] = [
  // PRIMARY: /chapter/{courseId}/{chapterId}  -- capture second segment
  /\/chapter\/[A-Za-z0-9_-]{8,}\/([A-Za-z0-9_-]{8,})\b/,
  // Fallbacks
  /\/student\/chapter\/[A-Za-z0-9_-]{8,}\/([A-Za-z0-9_-]{8,})\b/,
  /[/#]chapter-player[/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
  /[/#]ChapterPlayer[/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
  /\/ChapterPlayer\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
  /\/chapter-player\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
];

function extractChapterId(url: string): string | null {
  for (const re of CHAPTER_PATH_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Injected before content loads.
 *
 * 1. Installs window.icareNative.openChapter(id) explicit bridge.
 * 2. Monitors SPA client-side navigation (pushState / replaceState /
 *    popstate / hashchange).
 * 3. When the URL matches the chapter player pattern:
 *    a. Immediately posts OPEN_CHAPTER so the native player opens in its
 *       loading state.
 *    b. Fetches chapter metadata + Mux token from the API using the WebView's
 *       authenticated session cookies (which native fetch() cannot access),
 *       then posts CHAPTER_TOKENS.  On error posts CHAPTER_ERROR so the
 *       native player unblocks and shows a useful message.
 *    c. Steps history.back() so the user returns to the chapter list when
 *       pressing Back in the native player.
 */
const INJECTED_JS = `
  (function() {
    if (window.__icareNativeBridgeInstalled) return;
    window.__icareNativeBridgeInstalled = true;

    var _API_KEY  = '${API_KEY}';
    var _BASE_API = '${BASE_API}';

    // -- 1. Explicit bridge -------------------------------------------------------
    window.icareNative = {
      openChapter: function(id) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: id })
        );
      }
    };

    // -- 2. Authenticated token fetch (runs inside WebView, has cookies) ----------
    async function fetchAndPostTokens(chapterId) {
      try {
        var hdrs = { 'Content-Type': 'application/json', 'api_key': _API_KEY };

        // Fetch chapter metadata to get the correct playback ID
        var chRes = await fetch(_BASE_API + '/entities/Chapter/' + chapterId, {
          headers: hdrs,
          credentials: 'include'
        });
        if (!chRes.ok) {
          throw new Error('Chapter fetch failed (' + chRes.status + ')');
        }
        var chapter = await chRes.json();

        // Select playback ID: DRM > Signed > Public
        var playbackId = (chapter.muxDrmProtected && chapter.muxDrmPlaybackId)
          ? chapter.muxDrmPlaybackId
          : (chapter.muxSignedPlaybackRequired && chapter.muxSignedPlaybackId)
          ? chapter.muxSignedPlaybackId
          : (chapter.muxPlaybackId || null);

        if (!playbackId) {
          throw new Error('Chapter has no Mux playback ID configured');
        }

        // Fetch Mux signed token -- authenticated via session cookies
        var tkRes = await fetch(_BASE_API + '/functions/getMuxToken', {
          method: 'POST',
          headers: hdrs,
          credentials: 'include',
          body: JSON.stringify({ playbackId: playbackId })
        });
        if (!tkRes.ok) {
          var errBody = {};
          try { errBody = await tkRes.json(); } catch(ignored) {}
          throw new Error(errBody.error || ('getMuxToken failed (' + tkRes.status + ')'));
        }
        var tokens = await tkRes.json();

        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'CHAPTER_TOKENS', chapterId: chapterId, chapter: chapter, tokens: tokens })
        );
      } catch(err) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'CHAPTER_ERROR', chapterId: chapterId, error: String(err) })
        );
      }
    }

    // -- 3. SPA navigation monitoring --------------------------------------------
    function getChapterIdFromUrl(url) {
      // PRIMARY: /chapter/{courseId}/{chapterId} -- capture SECOND segment
      var primary = url.match(/\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})(?:\\/|\\?|$)/);
      if (primary) return primary[1];
      // Fallbacks
      var patterns = [
        /\\/student\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})/,
        /[\\/#]chapter-player[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
        /[\\/#]ChapterPlayer[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
        /\\/ChapterPlayer\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
        /\\/chapter-player\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = url.match(patterns[i]);
        if (m) return m[1];
      }
      return null;
    }

    var _lastFiredId = null;

    function checkUrl() {
      var chapterId = getChapterIdFromUrl(window.location.href);
      if (!chapterId || chapterId === _lastFiredId) return;
      _lastFiredId = chapterId;

      // Open the native player immediately in its loading state
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: chapterId })
      );

      // Fetch chapter data + Mux token using the authenticated WebView session
      fetchAndPostTokens(chapterId);

      // Step back so Back in the native player returns to the chapter list
      setTimeout(function() {
        if (typeof history.back === 'function') history.back();
        setTimeout(function() { _lastFiredId = null; }, 1500);
      }, 250);
    }

    // Patch history API for SPA navigation
    var _pushState = history.pushState;
    history.pushState = function() {
      _pushState.apply(this, arguments);
      setTimeout(checkUrl, 150);
