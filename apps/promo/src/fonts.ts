import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/**
 * Bundled Pretendard Variable (SIL OFL). Loaded through @remotion/fonts so that the
 * headless Chrome used by `remotion render` blocks until the face is ready — otherwise
 * Korean glyphs fall back mid-render and frames differ from the Studio preview.
 */
export const fontFamily = "PretendardPromo";

export const waitForFonts = loadFont({
  family: fontFamily,
  url: staticFile("fonts/PretendardVariable.woff2"),
  weight: "45 920",
  format: "woff2",
});
