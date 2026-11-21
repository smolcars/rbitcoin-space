import { describe, expect, it, vi } from "vitest";
import { cameraProblem, facesReader, openCamera, stopStream } from "./camera";

/** A stream of one video track, facing `facing`, whose `stop` is recorded. */
function fakeStream(facing?: string) {
  const track = {
    stop: vi.fn<() => void>(),
    getSettings: () => (facing ? { facingMode: facing } : {}),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

describe("cameraProblem", () => {
  it.each([
    ["NotAllowedError", "blocked"],
    ["SecurityError", "blocked"],
    ["NotFoundError", "none"],
    ["OverconstrainedError", "none"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["TypeError", "unavailable"],
  ] as const)("names %s %s", (name, problem) => {
    expect(cameraProblem(new DOMException("", name))).toBe(problem);
  });

  it("takes anything else for a browser that has no camera here", () => {
    expect(cameraProblem(new TypeError("No camera API"))).toBe("unavailable");
    expect(cameraProblem("odd")).toBe("unavailable");
  });
});

describe("openCamera", () => {
  it("asks for video only, the back camera where there is one", async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn<MediaDevices["getUserMedia"]>(() => Promise.resolve(stream));
    await expect(openCamera({ getUserMedia } as unknown as MediaDevices)).resolves.toBe(stream);
    const asked = getUserMedia.mock.calls[0]?.[0];
    expect(asked?.audio).toBe(false);
    expect(typeof asked?.video === "object" && asked.video.facingMode).toStrictEqual({
      ideal: "environment",
    });
  });

  it("rejects without the API (an insecure page, an old browser)", async () => {
    await expect(openCamera(undefined)).rejects.toThrow(TypeError);
  });
});

describe("stopStream and facesReader", () => {
  it("stops every track, and takes no stream calmly", () => {
    const { stream, track } = fakeStream();
    stopStream(stream);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(() => stopStream(undefined)).not.toThrow();
  });

  it("mirrors any camera but one facing away", () => {
    expect(facesReader(fakeStream("environment").stream)).toBe(false);
    expect(facesReader(fakeStream("user").stream)).toBe(true);
    expect(facesReader(fakeStream().stream)).toBe(true);
  });
});
