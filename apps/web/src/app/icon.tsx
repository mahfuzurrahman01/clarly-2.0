import { ImageResponse } from "next/og";

// Programmatic favicon (alongside the existing static favicon.ico) — an
// approximation of the brand's lime/ink palette. Swap for a designed
// public/icon.png once real brand assets exist.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#D7EE46",
          color: "#171717",
          fontSize: 20,
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        C
      </div>
    ),
    { ...size },
  );
}
