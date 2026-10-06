/*!
 * Clarly website chat widget (v2 S3).
 *
 *   <script src="https://YOUR-CONSOLE/widget.js" data-key="wk_..." data-api="https://YOUR-API" async></script>
 *
 * Self-contained: no dependencies, a Shadow DOM so the host page's CSS cannot
 * reach in (and ours cannot leak out), message text rendered with textContent
 * only — never innerHTML — so a message can never become markup on the host
 * page. The API refuses any website not on the widget's allow-list, so copying
 * this snippet onto another site does nothing.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__clarlyWidgetLoaded) return;
  window.__clarlyWidgetLoaded = true;

  var KEY = script.getAttribute("data-key") || "";
  var API = (script.getAttribute("data-api") || "").replace(/\/+$/, "");
  if (!/^wk_[A-Za-z0-9]{24}$/.test(KEY) || !/^https?:\/\//.test(API)) {
    console.warn("[clarly] widget: missing or invalid data-key / data-api");
    return;
  }

  var STORE = "clarly_widget_" + KEY;
  var POLL_OPEN_MS = 3000;
  var TYPING_TIMEOUT_MS = 45000;

  var TEXT = {
    en: {
      open: "Chat with us",
      close: "Close chat",
      placeholder: "Type a message…",
      send: "Send",
      typing: "Typing…",
      error: "Couldn't send. Try again.",
      slow: "Too many messages — wait a moment.",
      powered: "Powered by Clarly",
    },
    ar: {
      open: "تحدث معنا",
      close: "إغلاق المحادثة",
      placeholder: "اكتب رسالتك…",
      send: "إرسال",
      typing: "يكتب…",
      error: "تعذّر الإرسال. حاول مرة أخرى.",
      slow: "رسائل كثيرة — انتظر لحظة.",
      powered: "بدعم من Clarly",
    },
  };

  function store(value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(STORE) || "null");
      if (value === null) localStorage.removeItem(STORE);
      else localStorage.setItem(STORE, JSON.stringify(value));
    } catch (e) {
      /* private mode: the session lasts this page view */
    }
    return value;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      mode: "cors",
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    });
  }

  api("GET", "/widget/v1/config?key=" + encodeURIComponent(KEY)).then(start, function (err) {
    console.warn("[clarly] widget is not enabled for this website (" + (err && err.status) + ")");
  });

  function start(config) {
    var pageLang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
    var lang = config.locale === "auto" ? (pageLang.indexOf("ar") === 0 ? "ar" : "en") : config.locale;
    var t = TEXT[lang] || TEXT.en;
    var rtl = lang === "ar";
    var accent = /^#[0-9a-f]{6}$/i.test(config.accentColor) ? config.accentColor : "#16181D";
    var side = config.position === "left" ? "left" : "right";
    var title = config.title || config.businessName;

    var host = document.createElement("div");
    host.setAttribute("data-clarly-widget", "");
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;

    var style = document.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      "*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif}" +
      ".launcher{position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:" + accent + ";color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center}" +
      ".launcher:focus-visible,.send:focus-visible,.close:focus-visible{outline:3px solid #b6e33d;outline-offset:2px}" +
      ".panel{position:fixed;bottom:88px;" + side + ":20px;z-index:2147483000;width:min(370px,calc(100vw - 32px));height:min(560px,calc(100vh - 120px));background:#fbfaf7;color:#16181d;border:1px solid #e6e4de;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.18);display:none;flex-direction:column;overflow:hidden}" +
      ".panel.open{display:flex}" +
      ".head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px;background:" + accent + ";color:#fff}" +
      ".title{font-size:15px;font-weight:600;margin:0}" +
      ".close{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px}" +
      ".list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}" +
      ".msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}" +
      ".msg a{color:inherit;text-decoration:underline}" +
      ".visitor{align-self:flex-end;background:" + accent + ";color:#fff;border-end-end-radius:4px}" +
      ".business{align-self:flex-start;background:#fff;border:1px solid #e6e4de;border-end-start-radius:4px}" +
      ".pending{opacity:.6}" +
      ".typing{align-self:flex-start;font-size:12px;color:#6b6a66;padding:2px 4px}" +
      ".error{font-size:12px;color:#b42318;padding:0 14px 6px}" +
      ".error:empty{display:none}" +
      ".form{display:flex;gap:8px;padding:10px;border-top:1px solid #e6e4de;background:#fff}" +
      ".input{flex:1;resize:none;border:1px solid #e6e4de;border-radius:10px;padding:9px 11px;font-size:14px;max-height:120px;color:#16181d;background:#fff}" +
      ".input:focus{outline:2px solid #b6e33d;border-color:transparent}" +
      ".send{border:0;border-radius:10px;padding:0 14px;background:" + accent + ";color:#fff;font-size:14px;font-weight:600;cursor:pointer}" +
      ".send:disabled{opacity:.5;cursor:default}" +
      ".foot{font-size:11px;color:#8a8984;text-align:center;padding:0 0 8px;background:#fff}";
    root.appendChild(style);

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    var launcher = el("button", "launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", t.open);
    launcher.setAttribute("aria-expanded", "false");
    // Static, author-written SVG — the only markup this script ever sets.
    launcher.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    var panel = el("div", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", title);
    panel.setAttribute("dir", rtl ? "rtl" : "ltr");
    panel.setAttribute("lang", lang);
    var head = el("div", "head");
    head.appendChild(el("p", "title", title));
    var close = el("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", t.close);
    head.appendChild(close);
    var list = el("div", "list");
    list.setAttribute("aria-live", "polite");
    var error = el("div", "error");
    error.setAttribute("role", "alert");
    var form = el("form", "form");
    var input = el("textarea", "input");
    input.rows = 1;
    input.maxLength = 2000;
    input.placeholder = t.placeholder;
    input.setAttribute("aria-label", t.placeholder);
    var send = el("button", "send", t.send);
    send.type = "submit";
    form.appendChild(input);
    form.appendChild(send);
    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(error);
    panel.appendChild(form);
    panel.appendChild(el("div", "foot", t.powered));
    root.appendChild(panel);
    root.appendChild(launcher);

    var session = store();
    var server = []; // messages as the API returned them, oldest first
    var pending = []; // optimistic visitor messages not yet seen back
    var lastSeen = null; // createdAt of the newest server message
    var typingSince = 0;
    var pollTimer = null;

    /** Plain text with http(s) links as anchors — built node by node, never as HTML. */
    function renderText(node, text) {
      var re = /(https?:\/\/[^\s<>"']+)/g;
      var last = 0;
      var m;
      while ((m = re.exec(text))) {
        if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement("a");
        a.href = m[1];
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        a.textContent = m[1];
        node.appendChild(a);
        last = m.index + m[1].length;
      }
      if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
    }

    function render() {
      list.textContent = "";
      if (config.welcomeMessage) {
        var w = el("div", "msg business");
        renderText(w, config.welcomeMessage);
        list.appendChild(w);
      }
      var echoed = {};
      server.forEach(function (m) {
        if (m.clientMessageId) echoed[m.clientMessageId] = true;
        var n = el("div", "msg " + (m.from === "visitor" ? "visitor" : "business"));
        renderText(n, m.text);
        list.appendChild(n);
      });
      pending = pending.filter(function (p) {
        return !echoed[p.clientMessageId];
      });
      pending.forEach(function (p) {
        var n = el("div", "msg visitor pending");
        renderText(n, p.text);
        list.appendChild(n);
      });
      var businessReplies = server.filter(function (m) {
        return m.from === "business";
      });
      var lastBusiness = businessReplies[businessReplies.length - 1];
      var waiting =
        typingSince &&
        Date.now() - typingSince < TYPING_TIMEOUT_MS &&
        (!lastBusiness || Date.parse(lastBusiness.createdAt) < typingSince - 5000);
      if (waiting) list.appendChild(el("div", "typing", t.typing));
      else typingSince = 0;
      list.scrollTop = list.scrollHeight;
    }

    function ensureSession() {
      if (session && session.visitorId && session.token) return Promise.resolve(session);
      return api("POST", "/widget/v1/session", { key: KEY }).then(function (s) {
        session = store({ visitorId: s.visitorId, token: s.token });
        return session;
      });
    }

    function poll() {
      if (!session) return Promise.resolve();
      var q =
        "/widget/v1/messages?key=" + encodeURIComponent(KEY) +
        "&visitorId=" + encodeURIComponent(session.visitorId) +
        "&token=" + encodeURIComponent(session.token) +
        (lastSeen ? "&after=" + encodeURIComponent(lastSeen) : "");
      return api("GET", q).then(
        function (res) {
          if (res && res.messages && res.messages.length) {
            var known = {};
            server.forEach(function (m) {
              known[m.id] = true;
            });
            res.messages.forEach(function (m) {
              if (!known[m.id]) server.push(m);
            });
            lastSeen = server[server.length - 1].createdAt;
          }
          render();
        },
        function (err) {
          // The key was rotated or the session is no longer valid: start fresh.
          if (err && err.status === 403) session = store(null);
        },
      );
    }

    function schedule() {
      clearTimeout(pollTimer);
      if (!panel.classList.contains("open") || !session) return;
      pollTimer = setTimeout(function () {
        poll().then(schedule);
      }, POLL_OPEN_MS);
    }

    function toggle(open) {
      panel.classList.toggle("open", open);
      launcher.setAttribute("aria-expanded", String(open));
      if (open) {
        render();
        input.focus();
        poll().then(schedule);
      } else {
        clearTimeout(pollTimer);
        launcher.focus();
      }
    }

    function submit(e) {
      if (e) e.preventDefault();
      var text = input.value.trim();
      if (!text || send.disabled) return;
      error.textContent = "";
      var item = { clientMessageId: uuid(), text: text };
      pending.push(item);
      input.value = "";
      typingSince = Date.now();
      render();
      send.disabled = true;
      ensureSession()
        .then(function (s) {
          return api("POST", "/widget/v1/messages", {
            key: KEY,
            visitorId: s.visitorId,
            token: s.token,
            clientMessageId: item.clientMessageId,
            text: text,
          });
        })
        .then(
          function () {
            poll().then(schedule);
          },
          function (err) {
            pending = pending.filter(function (p) {
              return p !== item;
            });
            typingSince = 0;
            input.value = text;
            error.textContent = err && err.status === 429 ? t.slow : t.error;
            if (err && err.status === 403) session = store(null);
            render();
          },
        )
        .then(function () {
          send.disabled = false;
        });
    }

    launcher.addEventListener("click", function () {
      toggle(!panel.classList.contains("open"));
    });
    close.addEventListener("click", function () {
      toggle(false);
    });
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") toggle(false);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) submit(e);
    });
    form.addEventListener("submit", submit);
  }
})();
