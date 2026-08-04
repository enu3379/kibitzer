import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/**
 * Fonts are loaded through @remotion/fonts so the headless Chrome used by `remotion
 * render` blocks until each face is ready — otherwise Korean glyphs fall back mid-render
 * and frames differ from the Studio preview.
 *
 * Two faces, for two different reasons:
 *
 *   PretendardPromo — the *set*: browser chrome, the mock websites, the writing app. None
 *     of that is Kibitzer, and a neutral Korean sans keeps it from competing with the UI
 *     the film is actually about.
 *   Gowun Dodum — the *product*. The extension bundles this face itself and declares it
 *     first (`@font-face` in apps/extension-next/src/popup/popup.html), so the popup reads
 *     in it on every machine regardless of what is installed. It is not a substitution
 *     made for the video; it is the shipping typeface, copied out of the extension.
 */
export const fontFamily = "PretendardPromo";
export const popupFontFamily = "GowunDodumPromo";

export const waitForFonts = Promise.all([
  loadFont({
    family: fontFamily,
    url: staticFile("fonts/PretendardVariable.woff2"),
    weight: "45 920",
    format: "woff2",
  }),
  loadFont({
    family: popupFontFamily,
    url: staticFile("fonts/GowunDodum-Regular.woff2"),
    // The bundled file is Regular only; the browser synthesises 600/700, exactly as the
    // shipping @font-face comment says it should.
    weight: "400",
    format: "woff2",
  }),
]);
