const commandExamples = Object.freeze({
  today: Object.freeze({
    title: "Local development before npm publication",
    command: `# From the arcane-os-sdk checkout
npm ci
npm run check
npm run pack:local
node ./bin/arcane.mjs new local-app --path ../local-app --target portable --git

# From the generated app repository
cd ../local-app
npm install --save-dev --save-exact ../arcane-os-sdk/arcane-os-0.1.0-dev.3.tgz
npm run check`,
    note: "Use a packed tarball today. Local directory dependencies may become links and are intentionally rejected."
  }),
  loop: Object.freeze({
    title: "The focused application loop",
    command: `npm exec -- arcane doctor
npm exec -- arcane check
npm exec -- arcane dev
npm exec -- arcane package
npm exec -- arcane verify
npm exec -- arcane run --target browser

# Integrated shared/Core development selects one focused test or one check
node ../arcane-os-sdk/bin/arcane.mjs test --workspace "../Arcane OS" --scope shared --test-file test/component-contracts.test.mjs
node ../arcane-os-sdk/bin/arcane.mjs check --workspace "../Arcane OS" --scope shared

# Pair the portable provider through one explicit Arcane OS checkout
npm exec -- arcane native-doctor --target portable --arcane-root "../Arcane OS"
npm exec -- arcane build --target portable --arcane-root "../Arcane OS"

# In apps scaffolded with the matching --target, build, verify, launch,
# and own cancellation in the same process
npm exec -- arcane run --target windows-x64 --arcane-root "../Arcane OS"
npm exec -- arcane run --target linux-x64 --arcane-root "../Arcane OS"

# On a compatible native ARM64 Linux toolchain
npm exec -- arcane native-doctor --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test
npm exec -- arcane build --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test
npm exec -- arcane run --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test

# Android run requires one connected physical/native ARM64 device
npm exec -- arcane native-doctor --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
npm exec -- arcane build --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
npm exec -- arcane run --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development`,
    note: "Every native command requires a compatible --arcane-root and matching scaffold descriptor. Portable is verified but non-runnable; Windows and Linux are unsigned-local-test; Android is a development-signed, architecture-neutral APK with no native ABI."
  }),
  registry: Object.freeze({
    title: "After arcane-os@dev is published",
    command: `npx arcane-os@dev new my-app --path ./my-app --target portable --git
cd my-app
npm install
npm run check
npm run dev`,
    note: "These registry commands are post-publication instructions. arcane-os has not yet been published to npm."
  }),
  automation: Object.freeze({
    title: "Structured output for CI, Codex, and control panels",
    command: `npm exec -- arcane check --output ndjson
npm exec -- arcane doctor --output json
npm exec -- arcane targets --output json
npm exec -- arcane package --output ndjson`,
    note: "Machine modes keep stdout structured, acknowledge work before it begins, and return nonzero status on failure."
  })
});

function setupNavigation() {
  const header = document.querySelector("[data-site-header]");
  const toggle = document.querySelector("[data-nav-toggle]");
  const navigation = document.querySelector("[data-navigation]");
  if (!header || !toggle || !navigation) return;

  const label = toggle.querySelector(".visually-hidden");
  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    navigation.classList.remove("is-open");
    if (label) label.textContent = "Open navigation";
  };

  toggle.addEventListener("click", () => {
    const opening = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(opening));
    navigation.classList.toggle("is-open", opening);
    if (label) label.textContent = opening ? "Close navigation" : "Open navigation";
  });

  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navigation.classList.contains("is-open")) {
      close();
      toggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (!header.contains(event.target)) close();
  });

  const updateHeader = () => header.classList.toggle("is-scrolled", window.scrollY > 16);
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  const wideNavigation = window.matchMedia("(min-width: 761px)");
  wideNavigation.addEventListener("change", (event) => {
    if (event.matches) close();
  });
}

function setupCommandLab() {
  const tabs = [...document.querySelectorAll("[data-command-tab]")];
  const title = document.querySelector("[data-command-title]");
  const output = document.querySelector("[data-command-output]");
  const note = document.querySelector("[data-command-note]");
  const panel = document.querySelector("#command-panel");
  const copyButton = document.querySelector("[data-copy-command]");
  const copyStatus = document.querySelector("[data-copy-status]");
  if (!tabs.length || !title || !output || !note || !panel || !copyButton || !copyStatus) return;

  let activeKey = "today";
  let statusTimer = 0;

  const select = (key, focus = false) => {
    const example = commandExamples[key];
    if (!example) return;
    activeKey = key;
    for (const tab of tabs) {
      const selected = tab.dataset.commandTab === key;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) {
        panel.setAttribute("aria-labelledby", tab.id);
        if (focus) tab.focus();
      }
    }
    title.textContent = example.title;
    output.textContent = example.command;
    note.textContent = example.note;
    copyStatus.textContent = "";
  };

  const announce = (message) => {
    window.clearTimeout(statusTimer);
    copyStatus.textContent = message;
    statusTimer = window.setTimeout(() => {
      copyStatus.textContent = "";
    }, 2600);
  };

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Copy command was declined.");
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.dataset.commandTab));
    tab.addEventListener("keydown", (event) => {
      let next = null;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      select(tabs[next].dataset.commandTab, true);
    });
  });

  copyButton.addEventListener("click", async () => {
    try {
      await copyText(commandExamples[activeKey].command);
      announce("Commands copied.");
    } catch {
      announce("Copy failed. Select the commands manually.");
    }
  });

  select(activeKey);
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function setupSpaceMotion() {
  const canvas = document.querySelector("#space-canvas");
  const hero = document.querySelector(".hero");
  const motionButton = document.querySelector("[data-motion-toggle]");
  if (!(canvas instanceof HTMLCanvasElement) || !hero || !motionButton) return;

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const preferenceKey = "arcane-sdk-motion-paused";
  let stars = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastDraw = 0;
  let heroVisible = true;
  let userPaused = false;
  let pointerFrame = 0;

  try {
    userPaused = window.localStorage.getItem(preferenceKey) === "true";
  } catch {
    userPaused = false;
  }

  const isRunningAllowed = () => !userPaused && !reducedMotion.matches && heroVisible && !document.hidden;

  const updateMotionControl = () => {
    const operatingSystemPaused = reducedMotion.matches;
    motionButton.hidden = operatingSystemPaused;
    motionButton.setAttribute("aria-pressed", String(userPaused));
    motionButton.textContent = userPaused ? "Resume background motion" : "Pause background motion";
    document.body.classList.toggle("motion-paused", userPaused || operatingSystemPaused);
  };

  const buildStars = () => {
    const count = Math.max(45, Math.min(120, Math.round((width * height) / 12000)));
    const random = createRandom(0x41524341 + count);
    stars = Array.from({ length: count }, () => ({
      x: random(),
      y: random(),
      radius: 0.45 + random() * 1.25,
      opacity: 0.25 + random() * 0.52,
      phase: random() * Math.PI * 2,
      drift: 1 + random() * 4,
      violet: random() > 0.82
    }));
  };

  const draw = (time = 0) => {
    context.clearRect(0, 0, width, height);
    const seconds = time / 1000;
    for (const star of stars) {
      const drift = reducedMotion.matches || userPaused ? 0 : seconds * star.drift;
      const x = (star.x * width + drift) % Math.max(width, 1);
      const y = star.y * height;
      const pulse = reducedMotion.matches || userPaused ? 0 : Math.sin(seconds * 0.42 + star.phase) * 0.1;
      context.beginPath();
      context.fillStyle = star.violet
        ? `rgba(189, 161, 255, ${Math.max(0.12, star.opacity + pulse)})`
        : `rgba(202, 220, 255, ${Math.max(0.12, star.opacity + pulse)})`;
      context.arc(x, y, star.radius, 0, Math.PI * 2);
      context.fill();
    }
  };

  const stop = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  };

  const tick = (time) => {
    frame = 0;
    if (!isRunningAllowed()) {
      draw(time);
      return;
    }
    if (time - lastDraw >= 33) {
      draw(time);
      lastDraw = time;
    }
    frame = window.requestAnimationFrame(tick);
  };

  const syncLoop = () => {
    stop();
    updateMotionControl();
    draw(lastDraw);
    if (isRunningAllowed()) frame = window.requestAnimationFrame(tick);
  };

  const resize = () => {
    const nextWidth = Math.max(1, window.innerWidth);
    const nextHeight = Math.max(1, window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.round(nextWidth * pixelRatio);
    canvas.height = Math.round(nextHeight * pixelRatio);
    canvas.style.width = `${nextWidth}px`;
    canvas.style.height = `${nextHeight}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    buildStars();
    draw(lastDraw);
  };

  motionButton.addEventListener("click", () => {
    userPaused = !userPaused;
    try {
      window.localStorage.setItem(preferenceKey, String(userPaused));
    } catch {
      // The preference remains active for this page even when storage is unavailable.
    }
    syncLoop();
  });

  document.addEventListener("visibilitychange", syncLoop);
  reducedMotion.addEventListener("change", syncLoop);
  window.addEventListener("resize", resize, { passive: true });

  const heroObserver = new IntersectionObserver((entries) => {
    heroVisible = entries.some((entry) => entry.isIntersecting);
    syncLoop();
  }, { rootMargin: "120px 0px" });
  heroObserver.observe(hero);

  window.addEventListener("pointermove", (event) => {
    if (!finePointer.matches || reducedMotion.matches || userPaused || pointerFrame) return;
    pointerFrame = window.requestAnimationFrame(() => {
      pointerFrame = 0;
      const x = ((event.clientX / Math.max(window.innerWidth, 1)) - 0.5) * 12;
      const y = ((event.clientY / Math.max(window.innerHeight, 1)) - 0.5) * 12;
      document.documentElement.style.setProperty("--mouse-x", `${x.toFixed(2)}px`);
      document.documentElement.style.setProperty("--mouse-y", `${y.toFixed(2)}px`);
      document.documentElement.style.setProperty("--mouse-x-reverse", `${(-x * 0.5).toFixed(2)}px`);
      document.documentElement.style.setProperty("--mouse-y-reverse", `${(-y * 0.5).toFixed(2)}px`);
    });
  }, { passive: true });

  resize();
  syncLoop();
}

setupNavigation();
setupCommandLab();
setupSpaceMotion();
