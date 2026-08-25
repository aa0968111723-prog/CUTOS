import { describe, expect, it } from "vitest";
import { parseTimeRefs, resolveTimeRefs, formatClock } from "./time-parse.js";

const anchor = { playheadMs: 25_000, lastMs: 12_000, sourceDurationMs: 120_000 };

function absoluteMs(text: string): number[] {
  return resolveTimeRefs(parseTimeRefs(text), anchor);
}

describe("parseTimeRefs", () => {
  it("parses 0:25, 00:25 and 1:02", () => {
    expect(absoluteMs("0:25")).toEqual([25_000]);
    expect(absoluteMs("00:25")).toEqual([25_000]);
    expect(absoluteMs("1:02")).toEqual([62_000]);
  });

  it("parses 25秒 / 第25秒 / 25 秒那邊", () => {
    expect(absoluteMs("25秒")).toEqual([25_000]);
    expect(absoluteMs("第25秒")).toEqual([25_000]);
    expect(absoluteMs("25 秒那邊")).toEqual([25_000]);
  });

  it("parses 一分二十五秒 and 1:25", () => {
    expect(absoluteMs("一分二十五秒")).toEqual([85_000]);
    expect(absoluteMs("1:25")).toEqual([85_000]);
  });

  it("resolves 這裡 to the playhead", () => {
    expect(absoluteMs("這裡")).toEqual([25_000]);
  });

  it("resolves 剛剛 to the last observation", () => {
    expect(absoluteMs("剛剛")).toEqual([12_000]);
  });

  it("resolves 前面三秒 / 後面五秒 against the playhead", () => {
    expect(absoluteMs("前面三秒")).toEqual([22_000]);
    expect(absoluteMs("後面五秒")).toEqual([30_000]);
  });

  it("formats clocks with tenths", () => {
    expect(formatClock(25_000)).toBe("00:25.0");
    expect(formatClock(24_500)).toBe("00:24.5");
  });
});
