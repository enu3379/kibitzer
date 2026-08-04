import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { beat, clockAt, scene, sfx } from "./timeline";
import { CURSOR_PATH, EditorState, PageKind, stageAt } from "./scenes/script";
import { cursorAt } from "./lib/cursor";
import { range } from "./lib/anim";
import { editorApp, report, summary as summaryCopy } from "./copy";
import { MacDesktop } from "./components/desktop/MacDesktop";
import { AppWindow } from "./components/desktop/AppWindow";
import { AppSwitcher } from "./components/desktop/AppSwitcher";
import { BrowserWindow } from "./components/browser/BrowserWindow";
import { ExtensionPopup } from "./components/extension/ExtensionPopup";
import { KibitzerToast } from "./components/toast/Toast";
import { Cursor } from "./components/Cursor";
import { EndCard } from "./components/EndCard";
import { NewTabMock } from "./components/sites/NewTabMock";
import { NewsMock } from "./components/sites/NewsMock";
import { StatsMock } from "./components/sites/StatsMock";
import { TubeMock } from "./components/sites/TubeMock";
import { EditorMock } from "./components/sites/EditorMock";
import { MailMock } from "./components/sites/MailMock";

/** The writing app's window rect, in logical px — offset so the browser stays readable behind it. */
const EDITOR_RECT = { x: 88, y: 68, width: 930, height: 742 } as const;

const Page: React.FC<{ page: PageKind }> = ({ page }) => {
  switch (page.k) {
    case "newtab":
      return <NewTabMock />;
    case "news":
      return <NewsMock scroll={page.scroll} />;
    case "stats":
      return <StatsMock reveal={page.reveal} />;
    case "tube":
      return <TubeMock videoIndex={page.video} progress={page.progress} />;
    case "mail":
      return <MailMock reveal={page.reveal} sendHot={page.sendHot} sent={page.sent} />;
  }
};

const EditorApp: React.FC<{ editor: EditorState; active: boolean }> = ({ editor, active }) => (
  <AppWindow {...EDITOR_RECT} title={editorApp.name} subtitle={report.title} active={active}>
    <EditorMock
      lines={editor.lines}
      showCaret={editor.caret && active}
      body={editor.body}
      scroll={editor.scroll}
      complete={editor.complete}
    />
  </AppWindow>
);

export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  const st = stageAt(frame);
  const cursor = cursorAt(frame, CURSOR_PATH);

  const browserFocused = st.focus === "browser";

  const browser = (
    <BrowserWindow
      key="browser"
      tabs={st.tabs}
      activeId={st.activeId}
      url={st.url}
      dot={st.dot}
      extHighlight={st.popup !== null}
      active={browserFocused}
    >
      <Page page={st.page} />
      {st.toast ? (
        <KibitzerToast
          celebration={st.toast.celebration}
          message={st.toast.message}
          context={st.toast.context}
          reveal={st.toast.reveal}
          lift={st.toast.lift}
          peek={st.toast.peek}
          hotButton={st.toast.hotButton}
          closeHot={st.toast.closeHot}
        />
      ) : null}
      {st.popup ? <ExtensionPopup state={st.popup.state} frame={frame} summary={summaryCopy} reveal={st.popup.reveal} /> : null}
    </BrowserWindow>
  );

  const editor = st.editor ? <EditorApp key="editor" editor={st.editor} active={!browserFocused} /> : null;

  // S8 crossfade — the desktop dips out as the brand card rises.
  const endIn = range(frame, [beat.endCardIn, beat.endCardIn + 16], [0, 1]);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ opacity: 1 - endIn }}>
        <MacDesktop clock={clockAt(frame)} app={st.focus} zoom={st.zoom}>
          {/* Stacking order follows focus: the frontmost app is rendered last. */}
          {browserFocused ? [editor, browser] : [browser, editor]}
          {st.switcher ? <AppSwitcher selected={st.switcher.selected} opacity={st.switcher.opacity} /> : null}
          {frame < scene.s8EndCard.from ? <Cursor state={cursor} /> : null}
        </MacDesktop>
      </AbsoluteFill>

      <AbsoluteFill style={{ opacity: endIn, pointerEvents: "none" }}>
        <EndCard
          logoIn={range(frame, [beat.endCardIn + 4, beat.endCardIn + 22], [0, 1])}
          textIn={range(frame, [beat.endCardIn + 12, beat.endCardIn + 30], [0, 1])}
          subIn={range(frame, [beat.endCardIn + 22, beat.endCardIn + 40], [0, 1])}
        />
      </AbsoluteFill>

      {sfx.map((cue, i) => (
        <Sequence key={i} from={cue.at} name={`sfx-${i}`}>
          <Audio src={staticFile(cue.file)} volume={0.55} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
