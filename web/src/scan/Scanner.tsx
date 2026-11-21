// The QR scanner: the camera's view with a frame to hold a code in, and a picture to choose
// instead. Loaded on first use (ScanButton.tsx). What a code holds is handed back as text and
// never shown here: the search reads it (search/query.ts), and it is attacker-controlled.
import { createSignal, createUniqueId, onCleanup, onSettled, Show } from "solid-js";
import { type CameraProblem, cameraProblem, facesReader, openCamera, stopStream } from "./camera";
import { createDecoder, type Decoder, readPicture as readWays, visibleSquare } from "./decode";
import "./Scanner.css";

export interface ScannerProps {
  /** A code was read: its text, exactly as it holds it. */
  onResult: (text: string) => void;
  /** Escape, the close button or a press outside. */
  onClose: () => void;
}

type Camera =
  | { kind: "starting" }
  | { kind: "live"; mirrored: boolean }
  | { kind: "off"; problem: CameraProblem };
type Picture = "idle" | "reading" | "nothing" | "unreadable";

/** The pause between two frames read: about eight a second, so a phone stays cool. */
const FRAME_GAP_MS = 120;

const PROBLEMS: Record<CameraProblem, string> = {
  blocked:
    "The camera is blocked for this site. Allow it in your browser's settings, or choose a picture of the code.",
  none: "No camera found. Choose a picture of the code instead.",
  busy: "The camera did not start: another app may be using it. Try again, or choose a picture.",
  unavailable: "This browser cannot use a camera here. Choose a picture of the code instead.",
};

/** A duration token in ms, written in ms or s (the minifier rewrites `260ms` as `.26s`). */
function tokenMs(el: Element, name: string): number {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith("ms") ? n : n * 1000;
}

export default function Scanner(props: ScannerProps) {
  const titleId = createUniqueId();
  let dialog: HTMLDialogElement | undefined;
  let video: HTMLVideoElement | undefined;
  let file: HTMLInputElement | undefined;
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Closed, or a code read: nothing may start the camera or report a result after this.
  let ended = false;

  const [camera, setCamera] = createSignal<Camera>({ kind: "starting" });
  const [picture, setPicture] = createSignal<Picture>("idle");
  const [readerFailed, setReaderFailed] = createSignal(false);
  const [found, setFound] = createSignal(false);

  // One reader for the camera and pictures; one whose download failed is asked for again.
  let decoding: Promise<Decoder> | undefined;
  const decoder = () => {
    decoding ??= (async () => {
      try {
        return await createDecoder();
      } catch (error) {
        decoding = undefined;
        throw error;
      }
    })();
    return decoding;
  };

  const stopCamera = () => {
    clearTimeout(timer);
    stopStream(stream);
    stream = undefined;
    if (video) video.srcObject = null;
  };

  // The frame closes on the code, then the result is handed on.
  const finish = (text: string) => {
    if (ended) return;
    ended = true;
    stopCamera();
    setFound(true);
    const wait = dialog ? tokenMs(dialog, "--dur-base") : 0;
    timer = setTimeout(() => props.onResult(text), wait);
  };

  const readFrames = async (live: MediaStream) => {
    framesFor = live;
    let reader: Decoder;
    try {
      reader = await decoder();
    } catch {
      // The camera shows but reads nothing: Try again, or a picture whose reader loads, restarts it.
      if (stream === live) {
        framesFor = undefined;
        setReaderFailed(true);
      }
      return;
    }
    // Each frame is read one of the decoder's ways, in turn: a frame is cheap, and the next comes.
    let frame = 0;
    // The frame as the preview shows it, cut on a canvas of its own.
    const shown = document.createElement("canvas");
    const cut = shown.getContext("2d");
    const tick = async () => {
      if (ended || stream !== live || !video || !cut) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        let text: string | null = null;
        frame += 1;
        try {
          const { x, y, side } = visibleSquare(video.videoWidth, video.videoHeight);
          shown.width = side;
          shown.height = side;
          cut.drawImage(video, x, y, side, side, 0, 0, side, side);
          text = await reader.detect(shown, side, side, frame);
        } catch {
          // A frame that cannot be read: the next one is tried.
        }
        if (ended || stream !== live) return;
        // A picture being read has the say: the reader chose it over what the camera sees.
        if (text !== null && !pickerOpen && !readingPicture) {
          finish(text);
          return;
        }
      }
      timer = setTimeout(() => void tick(), FRAME_GAP_MS);
    };
    await tick();
  };

  // Each camera request and each picture chosen is numbered: only the latest may act.
  let asked = 0;
  let chosen = 0;
  // While the picker is open, and while the latest picture is read, what the camera finds waits.
  // Two flags, as a second picker can open while a picture is still read. Variables, so the frame
  // loop reads them the moment they change.
  let pickerOpen = false;
  let readingPicture = false;
  // The stream whose frames are being read, if any.
  let framesFor: MediaStream | undefined;

  const startCamera = async () => {
    // A code read: its result is on its way, and nothing may cancel it.
    if (ended) return;
    stopCamera();
    setReaderFailed(false);
    setCamera({ kind: "starting" });
    asked += 1;
    const mine = asked;
    let live: MediaStream;
    try {
      live = await openCamera("mediaDevices" in navigator ? navigator.mediaDevices : undefined);
    } catch (error) {
      if (!ended && mine === asked) setCamera({ kind: "off", problem: cameraProblem(error) });
      return;
    }
    // Closed, or asked again, while the browser asked: this camera goes straight off again.
    if (ended || mine !== asked || !video) {
      stopStream(live);
      return;
    }
    stream = live;
    video.srcObject = live;
    setCamera({ kind: "live", mirrored: facesReader(live) });
    // Unplugged, or the permission taken back while open.
    live.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (stream !== live || ended) return;
      stopCamera();
      setCamera({ kind: "off", problem: "busy" });
    });
    video.play().catch(() => undefined);
    await readFrames(live);
  };

  const readPicture = async (image: File) => {
    chosen += 1;
    const mine = chosen;
    // Only the latest picture speaks: one chosen after it replaces it.
    const current = () => !ended && mine === chosen;
    setPicture("reading");
    pickerOpen = false;
    readingPicture = true;
    try {
      // The reader first: one that loads now clears its failure and restarts the camera's frames.
      let reader: Decoder;
      try {
        reader = await decoder();
      } catch {
        if (current()) {
          setPicture("idle");
          setReaderFailed(true);
        }
        return;
      }
      // Closed, or replaced, while the reader downloaded: the picture is not opened at all.
      if (!current()) return;
      setReaderFailed(false);
      if (stream !== undefined && framesFor !== stream) void readFrames(stream);
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(image);
      } catch {
        if (current()) setPicture("unreadable");
        return;
      }
      let text: string | null;
      try {
        text = await readWays(reader, bitmap, bitmap.width, bitmap.height);
      } catch {
        if (current()) {
          setPicture("idle");
          setReaderFailed(true);
        }
        return;
      } finally {
        bitmap.close();
      }
      if (!current()) return;
      if (text === null) setPicture("nothing");
      else finish(text);
    } finally {
      if (mine === chosen) readingPicture = false;
    }
  };

  const status = () => {
    if (found()) return "Code read.";
    if (readerFailed()) return "The code reader did not load. Check your connection and try again.";
    const p = picture();
    if (p === "reading") return "Reading the picture…";
    if (p === "nothing") {
      return "No QR code found in that picture. Choose one where the whole code is sharp.";
    }
    if (p === "unreadable") return "That file is not a picture this browser can open.";
    const c = camera();
    if (c.kind === "starting") return "Starting the camera…";
    if (c.kind === "live") return "Hold the code inside the frame.";
    return PROBLEMS[c.problem];
  };
  const live = () => {
    const c = camera();
    return c.kind === "live" ? c : undefined;
  };
  const canRetry = () => {
    if (found()) return false;
    const c = camera();
    return (
      readerFailed() || (c.kind === "off" && (c.problem === "blocked" || c.problem === "busy"))
    );
  };

  const close = () => props.onClose();

  onSettled(() => {
    dialog?.showModal();
    // The dialog itself, not its first control: its name is read out, and no ring is drawn on
    // the close button that nobody chose.
    dialog?.focus();
    void startCamera();
  });
  onCleanup(() => {
    ended = true;
    stopCamera();
    if (dialog?.open === true) dialog.close();
  });

  return (
    // A press on the backdrop closes the scanner; Escape is the keyboard's way (onCancel).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a click on the dialog itself is a click on its backdrop
    <dialog
      ref={(el) => {
        dialog = el;
        // Focusable by script only (onSettled), never a Tab stop.
        el.tabIndex = -1;
      }}
      class={["scanner", { "scanner--found": found() }]}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // The file input's own cancel (its picker closed with nothing chosen) bubbles up to here.
        if (e.target !== dialog) return;
        e.preventDefault();
        close();
      }}
      // The browser may close it itself (a second Escape in Chrome): that is a close too.
      onClose={() => {
        if (!ended) close();
      }}
      onClick={(e) => {
        if (e.target === dialog) close();
      }}
    >
      <div class="scanner__panel">
        <div class="scanner__head">
          <h2 id={titleId} class="scanner__title">
            Scan a QR code
          </h2>
          <button type="button" class="scanner__close" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div class={["scanner__well", { "scanner__well--live": live() !== undefined }]}>
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a silent camera preview: no sound to caption */}
          <video
            ref={(el) => {
              video = el;
              // Inline and silent, as iOS requires a video to play without a tap.
              el.muted = true;
              el.playsInline = true;
              el.setAttribute("playsinline", "");
              el.setAttribute("disablepictureinpicture", "");
            }}
            class={["scanner__video", { "scanner__video--mirrored": live()?.mirrored === true }]}
            aria-hidden="true"
          />
          <Show when={live() === undefined}>
            <svg class="scanner__idle" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M5 11.5A2.5 2.5 0 0 1 7.5 9h3l2-3h7l2 3h3a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 5 23.5z" />
              <circle cx="16" cy="17" r="4.5" />
            </svg>
          </Show>
          <span class="scanner__frame" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
        </div>
        <p class="scanner__status" role="status">
          {status()}
        </p>
        <div class="scanner__actions">
          <button
            type="button"
            class="btn btn--accent"
            onClick={() => {
              // From the moment the picker opens: a code the camera finds meanwhile must not take
              // the reader away from the picture being chosen.
              pickerOpen = true;
              file?.click();
            }}
          >
            Choose a picture
          </button>
          <Show when={canRetry()}>
            <button type="button" class="btn" onClick={() => void startCamera()}>
              Try again
            </button>
          </Show>
        </div>
        <p class="scanner__note">
          The code is read on this device. Nothing from the camera leaves it.
        </p>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          // Closed with nothing chosen: the camera has the say again.
          onCancel={() => {
            pickerOpen = false;
          }}
          onChange={(e) => {
            const picked = e.currentTarget.files?.[0];
            // Cleared, so choosing the same picture again reads it again.
            e.currentTarget.value = "";
            if (picked) void readPicture(picked);
          }}
        />
      </div>
    </dialog>
  );
}
