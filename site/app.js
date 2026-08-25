async function copyText(text) {
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
}

function setupCopyButtons() {
  const buttons = [...document.querySelectorAll("[data-copy-button]")];
  const timers = new WeakMap();

  function announce(status, message) {
    const activeTimer = timers.get(status);
    if (activeTimer) window.clearTimeout(activeTimer);
    status.textContent = message;
    const timer = window.setTimeout(function clearCopyStatus() {
      status.textContent = "";
      timers.delete(status);
    }, 2600);
    timers.set(status, timer);
  }

  for (const button of buttons) {
    const block = button.closest(".code-block");
    const source = block?.querySelector("pre code");
    const status = block?.querySelector("[data-copy-status]");
    if (!source || !status) continue;

    async function handleCopyButton() {
      try {
        await copyText(source.textContent);
        announce(status, "Copied.");
      } catch {
        announce(status, "Copy failed. Select the text manually.");
      }
    }

    button.addEventListener("click", handleCopyButton);
  }
}

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

function setupPlayground() {
  const form = document.querySelector("[data-playground-form]");
  const workspace = document.querySelector("[data-playground-workspace]");
  const app = document.querySelector("[data-playground-app]");
  const operation = document.querySelector("[data-playground-operation]");
  const target = document.querySelector("[data-playground-target]");
  const root = document.querySelector("[data-playground-root]");
  const command = document.querySelector("[data-playground-command]");
  const descriptor = document.querySelector("[data-playground-descriptor]");
  const note = document.querySelector("[data-playground-note]");
  const status = document.querySelector("[data-playground-status]");
  if (!form || !workspace || !app || !operation || !target || !root || !command || !descriptor || !note || !status) return;

  const nativeTargets = new Set(["portable", "windows-x64", "linux-x64", "linux-arm64", "android-arm64"]);
  const targetOperations = new Set(["build", "run"]);
  const appPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
  const rootPattern = /^[a-zA-Z0-9 ._\\/:+-]+$/u;

  function targetFlags(targetName) {
    if (targetName === "linux-x64" || targetName === "linux-arm64") {
      return ["--format deb", "--signing unsigned-local-test"];
    }
    if (targetName === "android-arm64") {
      return ["--format apk", "--signing development"];
    }
    return [];
  }

  function renderPlayground() {
    const profile = workspace.value;
    const appId = app.value.trim();
    const action = operation.value;
    const targetName = target.value;
    const arcaneRoot = root.value.trim();
    const usesTarget = targetOperations.has(action);
    const usesNativeRoot = usesTarget && nativeTargets.has(targetName);

    target.disabled = !usesTarget;
    root.disabled = !usesNativeRoot && profile !== "integrated";
    command.textContent = "";
    note.textContent = "";
    status.textContent = "";

    if (!appPattern.test(appId)) {
      descriptor.textContent = "";
      status.textContent = "Use a lowercase kebab-case application ID, such as hello-world.";
      return;
    }
    if ((usesNativeRoot || profile === "integrated") && (!arcaneRoot || !rootPattern.test(arcaneRoot))) {
      descriptor.textContent = "";
      status.textContent = "Use a simple local checkout path without quotes or shell operators.";
      return;
    }
    if (action === "run" && targetName === "portable") {
      descriptor.textContent = JSON.stringify({id: appId, targets: ["browser", "portable"]}, null, 2);
      status.textContent = "Portable output is verified but cannot run. Choose Build target or select a runnable target.";
      return;
    }

    const parts = profile === "integrated"
      ? ["node ./bin/arcane.mjs", action, `--workspace \"${arcaneRoot}\"`, `--app ${appId}`]
      : ["npm exec -- arcane", action];

    if (usesTarget) parts.push(`--target ${targetName}`);
    if (usesNativeRoot) parts.push(`--arcane-root \"${arcaneRoot}\"`);
    if (profile === "integrated" && usesNativeRoot) parts.push("--output-root \"..\\arcane-native-output\"");
    if (usesTarget) parts.push(...targetFlags(targetName));

    const descriptorTargets = usesTarget && targetName !== "browser" ? ["browser", targetName].sort() : ["browser"];
    command.textContent = parts.join(" ");
    descriptor.textContent = JSON.stringify({
      id: appId,
      targets: descriptorTargets
    }, null, 2);

    if (!usesTarget) {
      note.textContent = "This operation stays in the browser/package workflow and does not select a native provider.";
    } else if (targetName === "browser") {
      note.textContent = "Browser output is packaged and verified without an Arcane OS native provider checkout.";
    } else if (targetName === "portable") {
      note.textContent = "Portable output is a verified app-scoped directory and has no executable run path.";
    } else if (targetName === "windows-x64") {
      note.textContent = "Windows output is unsigned local-development evidence, not a production release.";
    } else if (targetName === "android-arm64") {
      note.textContent = "Android uses a development-signed APK and run requires one connected physical ARM64 device.";
    } else {
      note.textContent = "Linux output is an unsigned-local-test DEB built on a compatible native toolchain.";
    }
  }

  function preventPlaygroundSubmit(event) {
    event.preventDefault();
    renderPlayground();
  }

  form.addEventListener("input", renderPlayground);
  form.addEventListener("change", renderPlayground);
  form.addEventListener("submit", preventPlaygroundSubmit);
  renderPlayground();
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
  const wideHero = window.matchMedia("(min-width: 981px)");
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

  const resetPointerOffset = () => {
    document.documentElement.style.setProperty("--mouse-x", "0px");
    document.documentElement.style.setProperty("--mouse-y", "0px");
    document.documentElement.style.setProperty("--mouse-x-reverse", "0px");
    document.documentElement.style.setProperty("--mouse-y-reverse", "0px");
  };

  motionButton.addEventListener("click", () => {
    userPaused = !userPaused;
    try {
      window.localStorage.setItem(preferenceKey, String(userPaused));
    } catch {
      // The preference remains active for this page even when storage is unavailable.
    }
    if (userPaused) resetPointerOffset();
    syncLoop();
  });

  document.addEventListener("visibilitychange", syncLoop);
  reducedMotion.addEventListener("change", (event) => {
    if (event.matches) resetPointerOffset();
    syncLoop();
  });
  wideHero.addEventListener("change", (event) => {
    if (!event.matches) resetPointerOffset();
  });
  window.addEventListener("resize", resize, { passive: true });

  const heroObserver = new IntersectionObserver((entries) => {
    heroVisible = entries.some((entry) => entry.isIntersecting);
    syncLoop();
  }, { rootMargin: "120px 0px" });
  heroObserver.observe(hero);

  window.addEventListener("pointermove", (event) => {
    if (!wideHero.matches || !finePointer.matches || reducedMotion.matches || userPaused || pointerFrame) return;
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
setupCopyButtons();
setupPlayground();
setupSpaceMotion();
