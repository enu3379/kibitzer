import React from "react";
import { Composition } from "remotion";
import { CANVAS, FPS } from "./theme";
import { TOTAL_FRAMES } from "./timeline";
import { Main } from "./Main";
import "./fonts";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="KibitzerPromo"
    component={Main}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={CANVAS.width}
    height={CANVAS.height}
  />
);
