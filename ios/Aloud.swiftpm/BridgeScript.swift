import Foundation

/// The JavaScript half of the native bridge, injected at document start — i.e.
/// before index.html's own script evaluates, so the web app can feature-detect
/// `window.__aloudNative` synchronously while it boots.
///
/// This is deliberately a *thin* shim. All the reader logic stays in index.html
/// where it is versioned, reviewable and shared with the web build; this file
/// only moves messages across the WKWebView boundary. Nothing here knows what a
/// sentence is.
enum BridgeScript {

    static let source = #"""
    (function () {
      'use strict';
      if (window.__aloudNative) return;

      var post = function (msg) {
        try {
          window.webkit.messageHandlers.aloudNative.postMessage(msg);
        } catch (e) {
          console.warn('[aloud-native] bridge post failed', e);
        }
      };

      var pendingVoices = null;

      var bridge = {
        /* index.html checks this to decide whether to offer the native engine.
           On the web it is undefined and nothing changes. */
        available: true,

        /* --- commands out to Swift ------------------------------------- */
        speak: function (token, text, rate, voiceId) {
          post({ cmd: 'speak', token: token, text: text, rate: rate, voiceId: voiceId || null });
        },
        stop:   function () { post({ cmd: 'stop' }); },
        pause:  function () { post({ cmd: 'pause' }); },
        resume: function () { post({ cmd: 'resume' }); },

        /* Resolves with [{id, name, lang, quality, gender}, ...] */
        listVoices: function () {
          return new Promise(function (resolve) {
            pendingVoices = resolve;
            post({ cmd: 'listVoices' });
          });
        },

        /* Lock-screen "now playing" text. Cheap enough to call on each sentence. */
        nowPlaying: function (title, progress, playing) {
          post({ cmd: 'nowPlaying', title: title || '', progress: progress || 0, playing: !!playing });
        },

        /* --- events in from Swift -------------------------------------- */
        /* index.html assigns these. Defaults are no-ops so an event that lands
           before the reader is wired up cannot throw. */
        onEvent: function () {},
        remote:  { play: function () {}, pause: function () {}, next: function () {}, prev: function () {} },

        _emit: function (ev) {
          if (ev && ev.type === 'voices') {
            if (pendingVoices) { pendingVoices(ev.voices || []); pendingVoices = null; }
            return;
          }
          try { bridge.onEvent(ev); } catch (e) { console.warn('[aloud-native] onEvent', e); }
        },

        _remote: function (action) {
          try {
            var fn = bridge.remote && bridge.remote[action];
            if (fn) fn();
          } catch (e) { console.warn('[aloud-native] remote', e); }
        }
      };

      Object.defineProperty(window, '__aloudNative', { value: bridge, writable: false, configurable: false });
    })();
    """#
}
