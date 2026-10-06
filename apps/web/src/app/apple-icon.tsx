import { ImageResponse } from "next/og";

// Apple touch icon — see icon.tsx for the same caveat (programmatic
// approximation of the brand palette, swap for a designed asset later).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
          fontSize: 100,
          fontWeight: 700,
          fontFamily: "sans-serif",
          borderRadius: 40,
        }}
      >
        C
      </div>
    ),
    { ...size },
  );
}
