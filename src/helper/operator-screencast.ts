// The Chromium frame source for the live view: CDP `Page.startScreencast` on the
// session's own CDP handle. Frames are handed to the hub as they arrive and the
// browser's own ack is left to the hub, which holds it to pace the stream.
//
// Nothing here logs a frame, keeps one, or writes one anywhere. A CDP failure
// is passed up as it is thrown, and the hub reports a code, never the message.

import type { CDPSession } from "playwright-core";
import type { ViewFrame, ViewHandle, ViewSource } from "./operator-view-hub.js";

/** `getCdp` is read at each start, so a stream restarted after the session's
 *  browser was rebuilt binds to the live handle. */
export function cdpViewSource(getCdp: () => CDPSession | undefined): ViewSource {
  return {
    async start(picture, onFrame): Promise<ViewHandle> {
      const cdp = getCdp();
      if (!cdp) throw new Error("no CDP handle");
      const listener = (ev: { data: string; sessionId: number }): void => {
        const frame: ViewFrame = {
          data: ev.data,
          ack: () =>
            void cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {
              // The page closed between the frame and its ack.
            }),
        };
        onFrame(frame);
      };
      cdp.on("Page.screencastFrame", listener);
      try {
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: picture.quality,
          maxWidth: picture.maxWidth,
          everyNthFrame: 1,
        });
      } catch (e) {
        cdp.off("Page.screencastFrame", listener);
        throw e;
      }
      return {
        async stop(): Promise<void> {
          cdp.off("Page.screencastFrame", listener);
          await cdp.send("Page.stopScreencast").catch(() => undefined);
        },
      };
    },
  };
}
