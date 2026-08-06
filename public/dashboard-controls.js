/**
 * Shared dashboard controls — progressive enhancements over native form elements so the operator gets
 * a control that matches the dark shell (and holds a proper popup) while the page's existing JS keeps
 * reading `.value` and listening for `change` on the very same element.
 *
 *   DashControls.enhanceSelect(selectEl)  — a styled listbox driven by a hidden native <select>.
 *   DashControls.attachDatePicker(inputEl) — a calendar + time popover driven by a hidden <input>.
 *
 * Both keep the original element in the DOM as the value store and emit native `change` events, so a
 * caller never has to know it was enhanced. Rebuilding a <select>'s <option>s (as several pages do on
 * refresh) is picked up automatically via a MutationObserver.
 *
 * The file also exports `DashModal` — the dialog used for forms and confirmations. It lives here
 * rather than in a page because a dialog has to cooperate with the popups above: Escape has to reach
 * an open calendar before it reaches the dialog holding it.
 */
(function () {
  "use strict";

  var openMenu = null; // the one open select/date popup, so a second open closes the first.

  document.addEventListener("click", function (event) {
    if (openMenu && !openMenu.root.contains(event.target)) openMenu.close();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && openMenu) {
      var m = openMenu;
      m.close();
      m.focusTrigger();
    }
  });

  // Lets a dialog tell "Escape closes the calendar I am holding" from "Escape closes me".
  function isMenuOpen() {
    return openMenu !== null;
  }

  var CARET =
    '<svg class="dctl-caret" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
  var CHECK =
    '<svg class="dctl-check" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 6 11l5.5-6.5"/></svg>';
  var CAL =
    '<svg class="dctl-cal-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></svg>';

  // Open a popup below its anchor by default, but flip it above when it would otherwise spill past the
  // bottom of the viewport and there is more room up top (e.g. a control near the end of the page).
  function placePopup(anchor, pop) {
    pop.classList.remove("is-up");
    var rect = anchor.getBoundingClientRect();
    var popHeight = pop.offsetHeight;
    var below = window.innerHeight - rect.bottom;
    var above = rect.top;
    if (popHeight + 8 > below && above > below) pop.classList.add("is-up");
  }

  function svgChevron(dir) {
    var d = dir === "left" ? "M14 5l-6 7 6 7" : "M10 5l6 7-6 7";
    return (
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
      d +
      '"/></svg>'
    );
  }

  // ---- Custom <select> ---------------------------------------------------
  function enhanceSelect(select) {
    if (!select || select.dataset.enhanced === "1") return;
    select.dataset.enhanced = "1";

    var root = document.createElement("div");
    root.className = "dctl-select";
    select.parentNode.insertBefore(root, select);
    root.appendChild(select);
    select.classList.add("dctl-native");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dctl-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = '<span class="dctl-value"></span>' + CARET;
    root.appendChild(trigger);

    var pop = document.createElement("div");
    pop.className = "dctl-pop";
    pop.hidden = true;
    var list = document.createElement("ul");
    list.className = "dctl-list";
    list.setAttribute("role", "listbox");
    list.tabIndex = -1;
    pop.appendChild(list);
    root.appendChild(pop);

    var valueSpan = trigger.querySelector(".dctl-value");
    var cursor = -1;

    function options() {
      return Array.prototype.slice.call(list.children);
    }

    function syncLabel() {
      var o = select.options[select.selectedIndex];
      valueSpan.textContent = o ? o.textContent : "";
      valueSpan.classList.toggle("is-placeholder", !o || o.value === "");
      trigger.disabled = select.disabled;
      root.classList.toggle("is-disabled", select.disabled);
    }

    function rebuild() {
      list.innerHTML = "";
      Array.prototype.forEach.call(select.options, function (o, i) {
        var li = document.createElement("li");
        li.className = "dctl-option";
        li.setAttribute("role", "option");
        li.dataset.index = String(i);
        li.setAttribute("aria-selected", i === select.selectedIndex ? "true" : "false");
        if (o.disabled) li.setAttribute("aria-disabled", "true");
        var label = document.createElement("span");
        label.className = "dctl-opt-label";
        label.textContent = o.textContent;
        li.appendChild(label);
        li.insertAdjacentHTML("beforeend", CHECK);
        list.appendChild(li);
      });
      syncLabel();
    }

    function setCursor(i) {
      var opts = options();
      opts.forEach(function (el) {
        el.removeAttribute("data-cursor");
      });
      cursor = i;
      if (i >= 0 && opts[i]) {
        opts[i].setAttribute("data-cursor", "true");
        opts[i].scrollIntoView({ block: "nearest" });
      }
    }

    function moveCursor(step) {
      var opts = options();
      if (!opts.length) return;
      var i = cursor;
      for (var n = 0; n < opts.length; n++) {
        i = (i + step + opts.length) % opts.length;
        if (!opts[i].hasAttribute("aria-disabled")) break;
      }
      setCursor(i);
    }

    function choose(i) {
      var o = select.options[i];
      if (!o || o.disabled) return;
      var changed = select.selectedIndex !== i;
      select.selectedIndex = i;
      rebuild();
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function open() {
      if (openMenu && openMenu !== instance) openMenu.close();
      if (select.disabled) return;
      pop.hidden = false;
      root.dataset.open = "true";
      trigger.setAttribute("aria-expanded", "true");
      openMenu = instance;
      placePopup(trigger, pop);
      setCursor(select.selectedIndex >= 0 ? select.selectedIndex : 0);
      list.focus();
    }

    function close() {
      pop.hidden = true;
      root.removeAttribute("data-open");
      trigger.setAttribute("aria-expanded", "false");
      if (openMenu === instance) openMenu = null;
    }

    var instance = { root: root, close: close, focusTrigger: function () { trigger.focus(); } };

    trigger.addEventListener("click", function () {
      if (pop.hidden) open();
      else close();
    });
    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    list.addEventListener("click", function (event) {
      var li = event.target.closest(".dctl-option");
      if (!li || li.hasAttribute("aria-disabled")) return;
      choose(Number(li.dataset.index));
      close();
      trigger.focus();
    });
    list.addEventListener("mousemove", function (event) {
      var li = event.target.closest(".dctl-option");
      if (li) setCursor(Number(li.dataset.index));
    });
    list.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveCursor(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveCursor(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setCursor(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setCursor(options().length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (cursor >= 0) {
          choose(cursor);
          close();
          trigger.focus();
        }
      } else if (event.key === "Tab") {
        close();
      }
    });

    // The page may swap the option list wholesale on refresh, or set .value directly.
    new MutationObserver(rebuild).observe(select, { childList: true });
    select.addEventListener("change", syncLabel);

    rebuild();
  }

  // ---- Custom date + time picker -----------------------------------------
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var WEEKDAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function toValue(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function parseValue(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  function formatDisplay(d) {
    return MONTHS_SHORT[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() + " · " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function sameDay(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function attachDatePicker(input) {
    if (!input || input.dataset.enhanced === "1") return;
    input.dataset.enhanced = "1";

    var placeholder = input.getAttribute("placeholder") || "Select date & time";
    input.type = "hidden";

    var root = document.createElement("div");
    root.className = "dctl-date";
    input.parentNode.insertBefore(root, input);
    root.appendChild(input);

    var field = document.createElement("button");
    field.type = "button";
    field.className = "dctl-date-field";
    field.innerHTML = CAL + '<span class="dctl-date-text"></span>' + CARET;
    root.appendChild(field);

    var pop = document.createElement("div");
    pop.className = "dctl-pop dctl-date-pop";
    pop.hidden = true;
    root.appendChild(pop);

    var selected = parseValue(input.value);
    var view = selected ? new Date(selected.getTime()) : new Date();
    view.setDate(1);

    var instance = { root: root, close: close, focusTrigger: function () { field.focus(); } };

    function renderField() {
      var t = field.querySelector(".dctl-date-text");
      if (selected) {
        t.textContent = formatDisplay(selected);
        t.classList.remove("is-placeholder");
      } else {
        t.textContent = placeholder;
        t.classList.add("is-placeholder");
      }
    }

    function commit() {
      input.value = selected ? toValue(selected) : "";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      renderField();
    }

    function buildGrid() {
      var year = view.getFullYear();
      var month = view.getMonth();
      var first = new Date(year, month, 1);
      var startDow = first.getDay();
      var daysInMonth = new Date(year, month + 1, 0).getDate();
      var today = new Date();

      var cells = "";
      for (var i = 0; i < startDow; i++) cells += '<span class="dctl-day is-blank"></span>';
      for (var day = 1; day <= daysInMonth; day++) {
        var dd = new Date(year, month, day);
        var cls = "dctl-day";
        if (sameDay(dd, selected)) cls += " is-selected";
        if (sameDay(dd, today)) cls += " is-today";
        cells += '<button type="button" class="' + cls + '" data-day="' + day + '">' + day + "</button>";
      }
      return cells;
    }

    function render() {
      var hh = selected ? selected.getHours() : 0;
      var mm = selected ? selected.getMinutes() : 0;
      pop.innerHTML =
        '<div class="dctl-cal-head">' +
          '<button type="button" class="dctl-nav" data-nav="-1" aria-label="Previous month">' + svgChevron("left") + "</button>" +
          '<span class="dctl-cal-title">' + MONTHS[view.getMonth()] + " " + view.getFullYear() + "</span>" +
          '<button type="button" class="dctl-nav" data-nav="1" aria-label="Next month">' + svgChevron("right") + "</button>" +
        "</div>" +
        '<div class="dctl-weekdays">' + WEEKDAYS.map(function (w) { return "<span>" + w + "</span>"; }).join("") + "</div>" +
        '<div class="dctl-grid">' + buildGrid() + "</div>" +
        '<div class="dctl-time">' +
          '<span class="dctl-time-label">Time (UTC)</span>' +
          '<div class="dctl-time-fields">' +
            '<input type="text" inputmode="numeric" maxlength="2" class="dctl-time-input" data-part="h" value="' + pad(hh) + '" aria-label="Hour" />' +
            '<span class="dctl-time-colon">:</span>' +
            '<input type="text" inputmode="numeric" maxlength="2" class="dctl-time-input" data-part="m" value="' + pad(mm) + '" aria-label="Minute" />' +
          "</div>" +
        "</div>" +
        '<div class="dctl-foot">' +
          '<button type="button" class="dctl-foot-btn" data-act="clear">Clear</button>' +
          '<button type="button" class="dctl-foot-btn" data-act="now">Now</button>' +
          '<button type="button" class="dctl-foot-btn is-primary" data-act="done">Done</button>' +
        "</div>";
    }

    function ensureSelected() {
      if (!selected) {
        selected = new Date(view.getFullYear(), view.getMonth(), 1, 0, 0, 0, 0);
      }
    }

    function open() {
      if (openMenu && openMenu !== instance) openMenu.close();
      view = selected ? new Date(selected.getFullYear(), selected.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      render();
      pop.hidden = false;
      root.dataset.open = "true";
      openMenu = instance;
      placePopup(field, pop);
    }
    function close() {
      pop.hidden = true;
      root.removeAttribute("data-open");
      if (openMenu === instance) openMenu = null;
    }

    field.addEventListener("click", function () {
      if (pop.hidden) open();
      else close();
    });

    pop.addEventListener("click", function (event) {
      var nav = event.target.closest(".dctl-nav");
      if (nav) {
        view.setMonth(view.getMonth() + Number(nav.dataset.nav));
        render();
        return;
      }
      var dayBtn = event.target.closest(".dctl-day");
      if (dayBtn && !dayBtn.classList.contains("is-blank")) {
        var h = selected ? selected.getHours() : 0;
        var m = selected ? selected.getMinutes() : 0;
        selected = new Date(view.getFullYear(), view.getMonth(), Number(dayBtn.dataset.day), h, m, 0, 0);
        commit();
        render();
        return;
      }
      var foot = event.target.closest(".dctl-foot-btn");
      if (foot) {
        var act = foot.dataset.act;
        if (act === "clear") {
          selected = null;
          commit();
          render();
        } else if (act === "now") {
          selected = new Date();
          selected.setSeconds(0, 0);
          view = new Date(selected.getFullYear(), selected.getMonth(), 1);
          commit();
          render();
        } else if (act === "done") {
          close();
          field.focus();
        }
      }
    });

    pop.addEventListener("input", function (event) {
      var box = event.target.closest(".dctl-time-input");
      if (!box) return;
      var digits = box.value.replace(/[^0-9]/g, "");
      box.value = digits;
    });
    pop.addEventListener("change", function (event) {
      var box = event.target.closest(".dctl-time-input");
      if (!box) return;
      var part = box.dataset.part;
      var n = parseInt(box.value, 10);
      if (isNaN(n)) n = 0;
      if (part === "h") n = Math.max(0, Math.min(23, n));
      else n = Math.max(0, Math.min(59, n));
      box.value = pad(n);
      ensureSelected();
      if (part === "h") selected.setHours(n);
      else selected.setMinutes(n);
      commit();
    });

    renderField();

    // A dialog reuses one enhanced input across every open, so it needs a way to put a value back in
    // (or clear the last one) without the picker being torn down and rebuilt.
    input.dashDate = {
      setValue: function (value) {
        selected = parseValue(value);
        input.value = selected ? toValue(selected) : "";
        renderField();
        if (!pop.hidden) render();
      },
      clear: function () {
        input.dashDate.setValue("");
      },
    };
    return input.dashDate;
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll("select[data-enhance]").forEach(enhanceSelect);
    (root || document).querySelectorAll("input[data-datepicker]").forEach(attachDatePicker);
  }

  window.DashControls = {
    enhanceSelect: enhanceSelect,
    attachDatePicker: attachDatePicker,
    enhanceAll: enhanceAll,
    isMenuOpen: isMenuOpen,
  };

  // ---- Modal dialogs ------------------------------------------------------
  var FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  var stack = [];

  function focusableIn(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0;
    });
  }

  /**
   * Show `card` (a .modal-card element, already in the document but hidden) over a scrim. The card is
   * moved into the scrim and returned to where it came from on close, so a caller can build its form
   * once — enhanced selects, calendars and all — and reopen it as often as it likes.
   *
   * opts.dismissible — click the scrim to close. Off by default: a half-filled form should not be
   * thrown away by a stray click. Escape always closes.
   */
  function openModal(card, opts) {
    opts = opts || {};

    var home = card.parentNode;
    var restoreFocus = document.activeElement;

    var scrim = document.createElement("div");
    scrim.className = "modal-scrim";
    scrim.appendChild(card);
    card.hidden = false;
    if (!card.hasAttribute("role")) {
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
    }
    document.body.appendChild(scrim);
    document.body.classList.add("modal-open");

    var instance = { card: card, scrim: scrim, close: close };
    stack.push(instance);

    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(instance), 1);
      document.removeEventListener("keydown", onKeydown, true);
      scrim.classList.add("is-closing");
      window.setTimeout(function () {
        card.hidden = true;
        if (home) home.appendChild(card);
        scrim.remove();
        if (!stack.length) document.body.classList.remove("modal-open");
      }, 140);
      if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
      if (opts.onClose) opts.onClose(result);
    }

    function onKeydown(event) {
      if (stack[stack.length - 1] !== instance) return;
      if (event.key === "Escape") {
        // A calendar or listbox open inside the dialog owns Escape first — closing the popup should
        // not also close the form it belongs to. Capture phase, so we see the key before it does.
        if (isMenuOpen()) return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      var items = focusableIn(card);
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeydown, true);

    // Only a press that both starts and ends on the scrim counts, so releasing a text selection
    // outside the card never dismisses it.
    var pressedScrim = false;
    scrim.addEventListener("mousedown", function (event) {
      pressedScrim = event.target === scrim;
    });
    // Bound to the scrim, which is built and thrown away per open — a card that gets reopened (a form
    // the page keeps around) would otherwise collect a listener every time.
    scrim.addEventListener("click", function (event) {
      if (event.target.closest("[data-modal-close]")) {
        close();
        return;
      }
      if (opts.dismissible && pressedScrim && event.target === scrim) close();
    });

    var autofocus = card.querySelector("[data-autofocus]") || focusableIn(card)[0];
    if (autofocus) window.setTimeout(function () { autofocus.focus(); }, 40);

    return instance;
  }

  var GLYPH = {
    danger:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17.2v.01"/></svg>',
    warn:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.4v.01"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/></svg>',
  };

  function escapeText(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * The replacement for window.confirm: same yes/no shape, but it can carry a note and a tone, and it
   * matches the shell instead of the browser. Resolves true only if the operator commits.
   */
  function confirmModal(options) {
    options = options || {};
    var tone = options.tone || "info";
    return new Promise(function (resolve) {
      var card = document.createElement("div");
      card.className = "modal-card";
      card.hidden = true;
      card.innerHTML =
        '<div class="modal-head">' +
          '<span class="modal-glyph ' + tone + '">' + (GLYPH[tone] || GLYPH.info) + "</span>" +
          '<div class="modal-titles"><h2>' + escapeText(options.title || "Are you sure?") + "</h2></div>" +
          '<button type="button" class="modal-close" data-modal-close aria-label="Close">' +
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
          "</button>" +
        "</div>" +
        '<div class="modal-body"><p>' + escapeText(options.body || "") + "</p>" +
          (options.note ? '<div class="modal-note">' + escapeText(options.note) + "</div>" : "") +
        "</div>" +
        '<div class="modal-foot"><span class="spacer"></span>' +
          '<button type="button" class="button" data-act="cancel">' + escapeText(options.cancelLabel || "Cancel") + "</button>" +
          '<button type="button" class="button primary' + (tone === "danger" ? " danger" : "") + '" data-act="ok" data-autofocus>' +
            escapeText(options.confirmLabel || "Confirm") +
          "</button>" +
        "</div>";
      document.body.appendChild(card);

      var settled = false;
      var instance = openModal(card, {
        dismissible: true,
        onClose: function () {
          if (!settled) {
            settled = true;
            resolve(false);
          }
          window.setTimeout(function () { card.remove(); }, 200);
        },
      });

      card.addEventListener("click", function (event) {
        var button = event.target.closest("button[data-act]");
        if (!button) return;
        if (button.dataset.act === "ok") {
          settled = true;
          resolve(true);
        }
        instance.close();
      });
    });
  }

  window.DashModal = { open: openModal, confirm: confirmModal };
})();
