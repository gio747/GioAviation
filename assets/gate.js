// Email gate for resource downloads.
// Any button with data-gate + data-doc + data-title opens this modal;
// on a valid email it POSTs to /api/subscribe, then downloads the file
// at resources/<data-doc>. A successful unlock is remembered per browser
// (localStorage) so returning visitors aren't asked twice for the same doc.

(function () {
  var overlay, form, titleEl, statusEl, emailInput, pendingBtn;

  function buildModal() {
    overlay = document.createElement("div");
    overlay.className = "gate-overlay";
    overlay.innerHTML =
      '<div class="gate-modal" role="dialog" aria-modal="true" aria-labelledby="gate-title">' +
      '<button type="button" class="gate-close" aria-label="Close">&times;</button>' +
      '<span class="eyebrow">Free download</span>' +
      '<h3 id="gate-title" class="gate-title"></h3>' +
      '<p class="gate-copy">Enter your email to unlock this document. It\'s used only to send occasional updates on new resources, never shared.</p>' +
      '<form class="gate-form">' +
      '<div class="field"><label for="gate-email">Email</label>' +
      '<input type="email" id="gate-email" name="email" required autocomplete="email"></div>' +
      '<button type="submit" class="btn" style="width:100%; justify-content:center;">Unlock &amp; download</button>' +
      '<div class="form-status" id="gate-status" role="status"></div>' +
      "</form>" +
      "</div>";
    document.body.appendChild(overlay);

    titleEl = overlay.querySelector(".gate-title");
    form = overlay.querySelector(".gate-form");
    statusEl = overlay.querySelector("#gate-status");
    emailInput = overlay.querySelector("#gate-email");

    overlay.querySelector(".gate-close").addEventListener("click", closeModal);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeModal();
    });

    form.addEventListener("submit", handleSubmit);
  }

  function openModal(btn) {
    pendingBtn = btn;
    titleEl.textContent = btn.dataset.title || "Document";
    statusEl.className = "form-status";
    statusEl.textContent = "";
    form.reset();
    overlay.classList.add("open");
    setTimeout(function () { emailInput.focus(); }, 50);
  }

  function closeModal() {
    overlay.classList.remove("open");
  }

  function handleSubmit(e) {
    e.preventDefault();
    var email = emailInput.value.trim();
    var doc = pendingBtn.dataset.doc;

    statusEl.className = "form-status";
    statusEl.textContent = "";

    fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, doc: doc }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (result.ok && result.data && result.data.ok) {
          rememberUnlock(doc);
          statusEl.className = "form-status ok";
          statusEl.textContent = "Unlocked — your download is starting.";
          triggerDownload(doc);
          setTimeout(closeModal, 1200);
        } else {
          statusEl.className = "form-status err";
          statusEl.textContent = "Couldn't verify that email. Please check it and try again.";
        }
      })
      .catch(function () {
        statusEl.className = "form-status err";
        statusEl.textContent = "Connection problem — please try again in a moment.";
      });
  }

  function triggerDownload(doc) {
    var a = document.createElement("a");
    a.href = "resources/" + doc;
    a.download = doc;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function rememberUnlock(doc) {
    try {
      var unlocked = JSON.parse(localStorage.getItem("gio_unlocked") || "[]");
      if (unlocked.indexOf(doc) === -1) unlocked.push(doc);
      localStorage.setItem("gio_unlocked", JSON.stringify(unlocked));
    } catch (e) { /* storage unavailable — gate still works, just asks again next visit */ }
  }

  function isUnlocked(doc) {
    try {
      var unlocked = JSON.parse(localStorage.getItem("gio_unlocked") || "[]");
      return unlocked.indexOf(doc) !== -1;
    } catch (e) { return false; }
  }

  document.addEventListener("DOMContentLoaded", function () {
    buildModal();
    var buttons = document.querySelectorAll("[data-gate]");
    buttons.forEach(function (btn) {
      if (isUnlocked(btn.dataset.doc)) {
        btn.textContent = "Download";
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          triggerDownload(btn.dataset.doc);
        });
      } else {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          openModal(btn);
        });
      }
    });
  });
})();
