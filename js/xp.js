// Shared desktop behaviour for every page: helpers, draggable windows,
// the taskbar, the start menu and the clock.

const XP = (() => {
  const desktopMode = window.matchMedia("(min-width: 901px)");

  let highestZ = 10;

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  // Text from Last.fm, Discord and the guestbook is escaped before it
  // goes into innerHTML.
  function escapeHTML(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeURL(url, fallback = "") {
    return /^https?:\/\//i.test(url || "") ? url : fallback;
  }

  // 95 000 ms -> "1 min", 8 040 000 ms -> "2h 14m", 3 days -> "3d 0h"
  function formatDuration(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));

    if (minutes < 1) return "less than a minute";
    if (minutes < 60) return `${minutes} min`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return `${hours}h ${minutes % 60}m`;

    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // "22:51" for today, "10 Nov, 22:51" for anything older
  function formatWhen(value) {
    const date = new Date(value);

    if (isNaN(date)) return "";

    if (date.toDateString() === new Date().toDateString()) {
      return formatTime(date);
    }

    return date.toLocaleString([], {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  /* ---------------------------------------------------------------- */
  /* Windows                                                           */
  /* ---------------------------------------------------------------- */

  function focusWindow(win) {
    document.querySelectorAll(".xp-window").forEach(other => {
      other.classList.toggle("is-active", other === win);
    });

    highestZ++;
    win.style.zIndex = highestZ;

    syncTaskbar();
  }

  function setHidden(win, hidden) {
    win.classList.toggle("is-hidden", hidden);

    if (hidden) {
      win.classList.remove("is-active");
    } else {
      focusWindow(win);
    }

    syncTaskbar();
  }

  function addControls(win) {
    const titlebar = win.querySelector(".xp-titlebar");

    if (!titlebar) return;

    const controls = document.createElement("div");
    controls.className = "xp-controls";
    controls.innerHTML = `
      <button type="button" data-action="minimize" aria-label="Minimize">_</button>
      <button type="button" disabled aria-hidden="true">□</button>
      <button type="button" class="xp-close" data-action="close" aria-label="Close">✕</button>
    `;

    controls.addEventListener("click", event => {
      if (event.target.closest("[data-action]")) setHidden(win, true);
    });

    titlebar.appendChild(controls);
  }

  // Windows stay in the page layout and are moved with a CSS transform,
  // so dragging one never shifts the others.
  function makeDraggable(win) {
    const titlebar = win.querySelector(".xp-titlebar");

    if (!titlebar) return;

    let drag = null;

    win.addEventListener("pointerdown", () => focusWindow(win));

    titlebar.addEventListener("pointerdown", event => {
      if (!desktopMode.matches) return;
      if (event.button !== 0 || event.target.closest(".xp-controls")) return;

      const desktop = win.closest(".desktop").getBoundingClientRect();
      const rect = win.getBoundingClientRect();

      const dx = parseFloat(win.style.getPropertyValue("--dx")) || 0;
      const dy = parseFloat(win.style.getPropertyValue("--dy")) || 0;

      drag = {
        startX: event.clientX,
        startY: event.clientY,
        dx,
        dy,
        // How far the window may move before it leaves the desktop
        minX: dx + (desktop.left - rect.left),
        maxX: dx + (desktop.right - rect.right),
        minY: dy + (desktop.top - rect.top),
        maxY: dy + Math.max(0, desktop.bottom - rect.bottom)
      };

      titlebar.setPointerCapture(event.pointerId);
    });

    titlebar.addEventListener("pointermove", event => {
      if (!drag) return;

      const dx = drag.dx + event.clientX - drag.startX;
      const dy = drag.dy + event.clientY - drag.startY;

      win.style.setProperty("--dx", Math.min(drag.maxX, Math.max(drag.minX, dx)) + "px");
      win.style.setProperty("--dy", Math.min(drag.maxY, Math.max(drag.minY, dy)) + "px");
    });

    const stop = () => { drag = null; };

    titlebar.addEventListener("pointerup", stop);
    titlebar.addEventListener("pointercancel", stop);
  }

  function resetWindowPositions() {
    document.querySelectorAll(".xp-window").forEach(win => {
      win.style.removeProperty("--dx");
      win.style.removeProperty("--dy");
    });
  }

  /* ---------------------------------------------------------------- */
  /* Taskbar + start menu                                              */
  /* ---------------------------------------------------------------- */

  function syncTaskbar() {
    document.querySelectorAll(".taskbar-item").forEach(item => {
      const win = document.getElementById(item.dataset.window);

      if (!win) return;

      item.classList.toggle("is-active", win.classList.contains("is-active"));
      item.classList.toggle("is-hidden", win.classList.contains("is-hidden"));
    });
  }

  function buildTaskbar() {
    const windows = [...document.querySelectorAll(".xp-window[id]")];
    const music = document.getElementById("bgmusic");

    const taskbar = document.createElement("div");
    taskbar.className = "taskbar";
    taskbar.innerHTML = `
      <button type="button" class="start-button" aria-haspopup="true" aria-expanded="false">
        <span aria-hidden="true">✦</span>start
      </button>

      <div class="taskbar-windows">
        ${windows.map(win => `
          <button type="button" class="taskbar-item" data-window="${escapeHTML(win.id)}">
            ${escapeHTML(win.dataset.title || win.id)}
          </button>
        `).join("")}
      </div>

      <div class="tray">
        ${music ? `<button type="button" class="tray-button" id="musicToggle" aria-label="Play or pause music" title="Music">🔇</button>` : ""}
        <span id="clock">00:00</span>
      </div>
    `;

    const menu = document.createElement("div");
    menu.className = "start-menu";
    menu.hidden = true;
    menu.innerHTML = `
      <div class="start-menu-header">
        <img src="images/jemima@weeluke.co.uk.jpg" alt="">
        Luke
      </div>

      <a class="start-menu-item" href="index.html">
        <img src="images/icons/generic-homepage.svg" alt=""> Home
      </a>
      <a class="start-menu-item" href="guestbook.html">
        <img src="images/icons/generic-review.svg" alt=""> Guestbook
      </a>
      <a class="start-menu-item" href="archive.html">
        <img src="images/icons/spotify.svg" alt=""> Music Archive
      </a>
      <a class="start-menu-item" href="mailto:me@weeluke.co.uk">
        <img src="images/icons/generic-email.svg" alt=""> Email Me
      </a>

      <div class="start-menu-footer">
        <button type="button" class="start-menu-item" id="logOff">Log Off</button>
      </div>
    `;

    document.body.append(menu, taskbar);

    const startButton = taskbar.querySelector(".start-button");

    const toggleMenu = open => {
      menu.hidden = !open;
      startButton.setAttribute("aria-expanded", String(open));
    };

    startButton.addEventListener("click", event => {
      event.stopPropagation();
      toggleMenu(menu.hidden);
    });

    document.addEventListener("click", event => {
      if (!menu.contains(event.target)) toggleMenu(false);
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") toggleMenu(false);
    });

    menu.querySelector("#logOff").addEventListener("click", () => {
      try {
        sessionStorage.removeItem("xpLoggedIn");
      } catch {
        // Storage can be blocked; logging off still goes home
      }

      location.href = "index.html";
    });

    taskbar.querySelectorAll(".taskbar-item").forEach(item => {
      item.addEventListener("click", () => {
        const win = document.getElementById(item.dataset.window);

        // Like XP: clicking the active window's button minimises it
        if (win.classList.contains("is-active") && !win.classList.contains("is-hidden")) {
          setHidden(win, true);
        } else {
          setHidden(win, false);
        }
      });
    });

    if (music) {
      const toggle = taskbar.querySelector("#musicToggle");

      const showState = () => {
        toggle.textContent = music.paused ? "🔇" : "🔊";
      };

      music.addEventListener("play", showState);
      music.addEventListener("pause", showState);

      toggle.addEventListener("click", () => {
        if (music.paused) {
          music.volume = 0.25;
          music.play().catch(() => {});
        } else {
          music.pause();
        }
      });
    }
  }

  function updateClock() {
    const clock = document.getElementById("clock");

    if (clock) clock.textContent = formatTime(new Date());
  }

  /* ---------------------------------------------------------------- */
  /* Start up                                                          */
  /* ---------------------------------------------------------------- */

  function init() {
    const windows = [...document.querySelectorAll(".xp-window")];

    windows.forEach(win => {
      addControls(win);
      makeDraggable(win);
    });

    buildTaskbar();

    const main = document.querySelector(".xp-window--center") || windows[0];
    if (main) focusWindow(main);

    updateClock();
    setInterval(updateClock, 1000);

    // Dragged positions don't make sense once the layout changes shape
    desktopMode.addEventListener("change", resetWindowPositions);
    window.addEventListener("resize", resetWindowPositions);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { escapeHTML, safeURL, formatDuration, formatTime, formatWhen };
})();
