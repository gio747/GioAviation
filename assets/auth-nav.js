/* GioAviation.aero — signed-in state for the public pages (articles).
   Asks /api/me who is looking at the page. A guest sees the page unchanged;
   a signed-in member sees their name, a link to the library and Log out
   instead of "Log in" / "Request access". */
(function () {
  var nav = document.querySelector('header.site nav.primary');
  if (!nav) return;

  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (res) { return res.json(); })
    .then(function (me) {
      if (!me || !me.loggedIn) return;

      var style = document.createElement('style');
      style.textContent =
        '.whoami{display:inline-flex;align-items:center;gap:8px;font-family:var(--font);font-size:0.8125rem;font-weight:600;color:var(--ink-inverse-soft);padding:6px 12px;border:1px solid rgba(255,255,255,.18);border-radius:999px;white-space:nowrap}' +
        '.whoami .dot{width:8px;height:8px;border-radius:50%;background:#5FD39A;flex:none}' +
        '.whoami strong{color:var(--ink-inverse);font-weight:700}' +
        '@media (max-width:860px){.whoami{display:none}}';
      document.head.appendChild(style);

      Array.prototype.forEach.call(nav.querySelectorAll('a[href="login.html"], a[href="richiedi-accesso.html"]'), function (a) {
        a.parentNode.removeChild(a);
      });

      var lib = document.createElement('a');
      lib.href = 'risorse.html';
      lib.textContent = 'Resources';
      nav.appendChild(lib);

      var who = document.createElement('span');
      who.className = 'whoami';
      who.title = 'You are signed in';
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      var strong = document.createElement('strong');
      strong.textContent = me.name || 'Member';
      who.appendChild(dot);
      who.appendChild(document.createTextNode('Signed in as '));
      who.appendChild(strong);
      nav.appendChild(who);

      var out = document.createElement('a');
      out.href = '/api/logout';
      out.className = 'btn ghost sm';
      out.textContent = 'Log out';
      nav.appendChild(out);
    })
    .catch(function () { /* guest view stays as is */ });
})();
