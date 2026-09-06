import Is from "../dependencies/strong-type/index.js";

const is = new Is(false);

export const WEBNN_BROWSER_SETTINGS = [
  { browserId: "chrome", name: "Google Chrome", url: "chrome://flags/#web-machine-learning-neural-network" },
  { browserId: "edge", name: "Microsoft Edge", url: "edge://flags/#web-machine-learning-neural-network" },
];

// Internal-page navigation may be blocked. The instructions remain available
// regardless; returning from this function is not evidence that settings opened.
export function openBrowserDeviceSettings(target, message) {
  try {
    globalThis.open?.(target.url, "_blank", "noopener,noreferrer");
  } catch {
    // Continue to the address-bar instructions when the browser rejects the URL.
  }
  globalThis.alert?.(message);
}

// Browser identity selects setup instructions, never hardware or model readiness.
export function getBrowserDeviceSettings(navigatorObject = globalThis.navigator) {
  const userAgent = String(navigatorObject?.userAgent ?? "");
  const clientHints = navigatorObject?.userAgentData;
  const platform = String(clientHints?.platform || navigatorObject?.platform || userAgent);
  const brands = new Set();
  for (const entry of clientHints?.brands ?? []) brands.add(entry.brand);
  const desktopWindows = /\b(?:Windows|Win32|Win64)\b/iu.test(platform)
    && clientHints?.mobile !== true
    && !/\b(?:Android|iPhone|iPad|iPod|Mobile)\b/iu.test(userAgent);
  let browserId = "unknown";
  let name = "this browser";
  let highPerformanceGpu = null;

  // Preserve the existing GPU guidance for browsers that also identify as Chrome.
  if (brands.has("Vivaldi") || /\bVivaldi\//u.test(userAgent)) {
    browserId = "vivaldi";
    name = "Vivaldi";
    highPerformanceGpu = { name, url: "vivaldi://flags/#force-high-performance-gpu" };
  } else if (brands.has("Brave") || is.function(navigatorObject?.brave?.isBrave)) {
    browserId = "brave";
    name = "Brave";
    highPerformanceGpu = { name, url: "brave://flags/#force-high-performance-gpu" };
  } else if (brands.has("Opera") || /\bOPR\//u.test(userAgent)) {
    browserId = "opera";
    name = "Opera";
    highPerformanceGpu = { name, url: "opera://flags/#force-high-performance-gpu" };
  } else if (brands.has("Microsoft Edge") || /\bEdg\//u.test(userAgent)) {
    browserId = "edge";
    name = "Microsoft Edge";
    highPerformanceGpu = { name, url: "edge://flags/#force-high-performance-gpu" };
  } else if (
    brands.has("Chromium")
    || brands.has("Google Chrome")
    || /\b(?:Chrome|Chromium)\//u.test(userAgent)
  ) {
    // Keep the established generic GPU address for Chromium browsers that mask their brand.
    highPerformanceGpu = { name: "your browser", url: "about://flags/#force-high-performance-gpu" };
    if (
      brands.has("Google Chrome")
      || (!clientHints?.brands && /\bChrome\//u.test(userAgent)
        && !/\b(?:SamsungBrowser|UCBrowser|YaBrowser)\//u.test(userAgent))
    ) {
      browserId = "chrome";
      name = "Google Chrome";
      highPerformanceGpu = { name, url: "chrome://flags/#force-high-performance-gpu" };
    } else {
      browserId = "chromium";
      name = "your Chromium browser";
    }
  }

  const webnnFlagsURL = WEBNN_BROWSER_SETTINGS.find(function matchesBrowser(entry) {
    return entry.browserId === browserId;
  })?.url ?? null;
  return {
    browserId,
    name,
    webnnFlagsURL,
    highPerformanceGpu: desktopWindows ? highPerformanceGpu : null,
    webnnAvailable: is.function(navigatorObject?.ml?.createContext),
    webgpuAvailable: Boolean(navigatorObject?.gpu),
  };
}

// Adapter selection is availability evidence, not the browser flag's state or
// proof that a model is executing on this GPU. The power preference is a hint.
export async function detectBrowserGpu(navigatorObject = globalThis.navigator) {
  if (!is.function(navigatorObject?.gpu?.requestAdapter)) {
    return { available: false, reason: "api-unavailable" };
  }
  const adapter = await navigatorObject.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { available: false, reason: "adapter-unavailable" };
  const info = adapter.info;
  return {
    available: true,
    name: info?.description
      || [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(" ")
      || "WebGPU adapter",
    isFallbackAdapter: is.boolean(info?.isFallbackAdapter)
      ? info.isFallbackAdapter
      : is.boolean(adapter.isFallbackAdapter) ? adapter.isFallbackAdapter : null,
  };
}
