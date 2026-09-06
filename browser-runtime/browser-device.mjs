/** Selects application settings from browser identity hints, including tablets. */
export function getBrowserDeviceClass(navigatorObject = globalThis.navigator) {
    const userAgent = String(navigatorObject?.userAgent ?? '');
    const clientHints = navigatorObject?.userAgentData;
    const platform = String(clientHints?.platform || navigatorObject?.platform || '');
    const mobile = clientHints?.mobile === true
        || /\b(?:Android|iOS|iPhone|iPad|iPod)\b/iu.test(platform)
        || /\b(?:Android|iPhone|iPad|iPod|Mobile)\b/iu.test(userAgent)
        // iPadOS can identify as a Mac while retaining its touch capabilities.
        || (/\b(?:MacIntel|Macintosh|macOS)\b/iu.test(platform)
            && navigatorObject?.maxTouchPoints > 1);
    return mobile ? 'mobile' : 'desktop';
}
