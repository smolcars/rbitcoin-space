// The scanner's camera: asking for it, and what each way of failing means to the reader.

/** Why the camera is not showing. */
export type CameraProblem =
  /** The reader or the browser refused it for this site. */
  | "blocked"
  /** The device has no camera. */
  | "none"
  /** Another app holds it, or the hardware failed to start. */
  | "busy"
  /** This browser offers no camera here: an old browser, or a page not served over HTTPS. */
  | "unavailable";

/** A getUserMedia rejection, by its DOMException name. */
export function cameraProblem(error: unknown): CameraProblem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "none";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unavailable";
}

/**
 * The back camera where there is one (a phone's), else whichever the device has. Video only.
 * Rejects with what getUserMedia rejects with, or a TypeError when there is no `mediaDevices`.
 */
export async function openCamera(media: MediaDevices | undefined): Promise<MediaStream> {
  if (media === undefined || typeof media.getUserMedia !== "function") {
    throw new TypeError("No camera API in this context");
  }
  return media.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      // A sharper frame reads a smaller code; the decoder scales it down (decode.ts MAX_SIDE).
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
}

/** Turns the camera off: every track stopped, so the browser's camera light goes out. */
export function stopStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Whether a preview should be mirrored: a camera facing the reader, as a mirror would show. */
export function facesReader(stream: MediaStream): boolean {
  const mode = stream.getVideoTracks()[0]?.getSettings().facingMode;
  // A laptop's camera often names no facing: it faces the reader.
  return mode !== "environment";
}
