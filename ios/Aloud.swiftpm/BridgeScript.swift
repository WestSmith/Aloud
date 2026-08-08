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
          return true;
        } catch (e) {
          console.warn('[aloud-native] bridge post failed', e);
          return false;
        }
      };

      var pendingVoices = null;
      var pageNonce = (self.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
      var nextKokoroRequest = 1;
      var pendingKokoro = Object.create(null);

      var cancelKokoroRequests = function (matches, message, code) {
        Object.keys(pendingKokoro).forEach(function (requestId) {
          var pending = pendingKokoro[requestId];
          if (!pending || !matches(pending)) return;
          clearTimeout(pending.timer);
          delete pendingKokoro[requestId];
          post({ cmd: 'kokoroCancel', requestId: requestId });
          var error = new Error(message);
          error.name = 'EngineReset';
          error.code = code;
          error.retryable = false;
          pending.reject(error);
        });
      };

      var kokoroRequest = function (cmd, payload, timeoutMs) {
        return new Promise(function (resolve, reject) {
          var requestId = pageNonce + ':' + (nextKokoroRequest++);
          var timer = setTimeout(function () {
            var pending = pendingKokoro[requestId];
            if (!pending) return;
            delete pendingKokoro[requestId];
            post({ cmd: 'kokoroCancel', requestId: requestId });
            var error = new Error(cmd === 'kokoroGenerate'
              ? 'Native Kokoro took too long to create this segment.'
              : 'Native Kokoro setup took too long.');
            error.code = 'native_timeout';
            error.retryable = true;
            reject(error);
          }, timeoutMs);
          pendingKokoro[requestId] = { cmd: cmd, resolve: resolve, reject: reject, timer: timer };
          var message = Object.assign({ cmd: cmd, requestId: requestId }, payload || {});
          if (!post(message)) {
            clearTimeout(timer);
            delete pendingKokoro[requestId];
            var error = new Error('The native Kokoro bridge is unavailable.');
            error.code = 'native_bridge_unavailable';
            error.retryable = true;
            reject(error);
          }
        });
      };

      var bridge = {
        /* index.html checks this to decide whether to offer the native engine.
           On the web it is undefined and nothing changes. */
        available: true,
        nativeKokoro: true,

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
        clearNowPlaying: function () {
          post({ cmd: 'clearNowPlaying' });
        },

        /* Full-quality Kokoro generation runs in Swift/MLX. Only a temporary
           local WAV URL and token timestamps cross this boundary. */
        kokoro: {
          onProgress: function () {},
          prepare: function () {
            return kokoroRequest('kokoroPrepare', null, 30 * 60 * 1000);
          },
          generate: function (text, voice) {
            return kokoroRequest('kokoroGenerate', { text: text || '', voice: voice || 'af_heart' }, 3 * 60 * 1000);
          },
          /* A document transition must not turn a still-valid model setup into
             an engine failure. Cancel only sentence generation owned by this
             page; preparation continues and warms the shared native model. */
          cancelGenerations: function () {
            cancelKokoroRequests(
              function (pending) { return pending.cmd === 'kokoroGenerate'; },
              'The open document changed.',
              'document_changed'
            );
          },
          release: function (audioId) {
            if (audioId) post({ cmd: 'kokoroRelease', audioId: audioId });
          }
        },

        /* --- events in from Swift -------------------------------------- */
        /* index.html assigns these. Defaults are no-ops so an event that lands
           before the reader is wired up cannot throw. */
        onEvent: function () {},
        remote:  { play: function () {}, pause: function () {}, toggle: function () {}, next: function () {}, prev: function () {} },

        _emit: function (ev) {
          if (ev && ev.type === 'kokoroProgress') {
            try { bridge.kokoro.onProgress(ev); } catch (e) { console.warn('[aloud-native] Kokoro progress', e); }
            return;
          }
          if (ev && ev.type === 'kokoroReply') {
            var pending = pendingKokoro[ev.requestId];
            if (!pending) {
              /* Cancellation can race a successful reply already crossing the
                 bridge. Nobody will fetch that WAV, so release it immediately
                 instead of waiting for the native cache's age-based cleanup. */
              /* Replies are broadcast to every Aloud scene. Only this page may
                 release a request bearing its nonce; another scene may still
                 be about to fetch its own successful result. */
              var ownedRequest = String(ev.requestId || '').indexOf(pageNonce + ':') === 0;
              if (ownedRequest && ev.ok && ev.result && ev.result.audioId) {
                post({ cmd: 'kokoroRelease', audioId: ev.result.audioId });
              }
              return;
            }
            delete pendingKokoro[ev.requestId];
            clearTimeout(pending.timer);
            if (ev.ok) pending.resolve(ev.result || {});
            else {
              var detail = ev.error || {};
              var error = new Error(detail.message || 'Native Kokoro failed.');
              error.code = detail.code || 'native_error';
              error.retryable = !!detail.retryable;
              pending.reject(error);
            }
            return;
          }
          if (ev && ev.type === 'voices') {
            if (pendingVoices) {
              pendingVoices(ev.voices || []);
              pendingVoices = null;
            } else {
              try { bridge.onEvent(ev); } catch (e) { console.warn('[aloud-native] voices event', e); }
            }
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

      addEventListener('pagehide', function () {
        cancelKokoroRequests(
          function () { return true; },
          'The reader page was closed.',
          'page_closed'
        );
      });
    })();
    """#
}
