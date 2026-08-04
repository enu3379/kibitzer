import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { beat, clockAt, clockRushAt, scene, sfx } from "./timeline";
import { CURSOR_PATH, EditorState, INPUT_SFX, PageKind, stageAt } from "./scenes/script";
import { SFX_FRAMES } from "./lib/inputsfx";
import { cursorAt } from "./lib/cursor";
import { range } from "./lib/anim";
/** The writing app's window rect lives with the page-break maths that is derived from it. */
import { EDITOR_RECT } from "./lib/doclayout";
import { editorApp, report } from "./copy";
import { MacDesktop } from "./components/desktop/MacDesktop";
import { AppWindow } from "./components/desktop/AppWindow";
import { AppSwitcher } from "./components/desktop/AppSwitcher";
import { BrowserWindow } from "./components/browser/BrowserWindow";
import { ExtensionPopup } from "./components/extension/ExtensionPopup";
import { KibitzerToast } from "./components/toast/Toast";
import { Cursor } from "./components/Cursor";
import { KeyHint } from "./components/KeyHint";
import { EndCard } from "./components/EndCard";
import { NewTabMock } from "./components/sites/NewTabMock";
import { NewsMock } from "./components/sites/NewsMock";
import { StatsMock } from "./components/sites/StatsMock";
import { SearchMock } from "./components/sites/SearchMock";
import { TubeMock } from "./components/sites/TubeMock";
import { EditorMock } from "./components/sites/EditorMock";
import { MailMock } from "./components/sites/MailMock";
import { InstagramDM, InstagramFeed } from "./components/sites/InstagramMock";
import { PortalMock } from "./components/sites/PortalMock";
import { ShopMock } from "./components/sites/ShopMock";

const Page: React.FC<{ page: PageKind }> = ({ page }) => {
  switch (page.k) {
    case "newtab":
      return <NewTabMock />;
    case "news":
      return <NewsMock scroll={page.scroll} variant={page.variant} selectQuote={page.select} />;
    case "search":
      return <SearchMock set={page.set} query={page.query} hot={page.hot} />;
    case "stats":
      return <StatsMock reveal={page.reveal} select={page.select} view={page.view} />;
    case "tube":
      return <TubeMock videoIndex={page.video} progress={page.progress} />;
    case "igFeed":
      return <InstagramFeed scroll={page.scroll} />;
    case "igDm":
      return (
        <InstagramDM
          activeThread={page.thread}
          messages={page.messages}
          typing={page.typing}
          dmBadge={page.badge}
          unreadRows={page.unreadRows}
          flashThread={page.flashThread}
          composing={page.composing}
          linkHot={page.linkHot}
        />
      );
    case "portal":
      return <PortalMock query={page.query} adHot={page.adHot} />;
    case "shop":
      return (
        <ShopMock
          view={page.view}
          listScroll={page.listScroll}
          listHot={page.listHot}
          results={page.results}
          query={page.query}
          searchFocus={page.searchFocus}
          productIndex={page.product}
          cartCount={page.cart}
          cartPulse={page.cartPulse}
          cartItems={page.cartItems}
          addHot={page.addHot}
          recItems={page.rec}
          recHot={page.recHot}
        />
      );
    case "mail":
      return <MailMock reveal={page.reveal} sendHot={page.sendHot} sent={page.sent} />;
  }
};

const EditorApp: React.FC<{ editor: EditorState; active: boolean }> = ({ editor, active }) => (
  <AppWindow {...EDITOR_RECT} title={editorApp.name} subtitle={report.title} active={active}>
    <EditorMock blocks={editor.blocks} showCaret={editor.caret && active} pasteFlash={editor.pasteFlash} scroll={editor.scroll} />
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
      omni={st.omni}
      dot={st.dot}
      extHighlight={st.popup !== null}
      backHot={st.backHot}
      forwardOn={st.forwardOn}
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
      {st.popup ? <ExtensionPopup state={st.popup.state} frame={frame} reveal={st.popup.reveal} /> : null}
    </BrowserWindow>
  );

  const editor = st.editor ? <EditorApp key="editor" editor={st.editor} active={!browserFocused} /> : null;

  // S8 crossfade — the desktop dips out as the brand card rises.
  const endIn = range(frame, [beat.endCardIn, beat.endCardIn + 16], [0, 1]);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ opacity: 1 - endIn }}>
        <MacDesktop clock={clockAt(frame)} clockRush={clockRushAt(frame)} app={st.focus} zoom={st.zoom}>
          {/* Stacking order follows focus: the frontmost app is rendered last. */}
          {browserFocused ? [editor, browser] : [browser, editor]}
          {st.switcher ? <AppSwitcher selected={st.switcher.selected} opacity={st.switcher.opacity} /> : null}
          {st.keyHint ? <KeyHint state={st.keyHint} /> : null}
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

      {/*
       * The hands. These are bounded rather than left open like the four authored cues
       * above: there are hundreds of them, and an unbounded Sequence keeps every one
       * mounted for the rest of the film once it has fired.
       */}
      {INPUT_SFX.map((cue, i) => (
        <Sequence key={`in-${i}`} from={cue.at} durationInFrames={SFX_FRAMES} name={`input-${i}`}>
          <Audio src={staticFile(cue.file)} volume={cue.volume} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
