import { ImageResponse } from "next/og";

// Programmatically generated OG image — approximates the brand's lime/ink
// palette (see globals.css --lime/--ink, defined in OKLCH, which satori
// can't render directly) in plain hex. Swap this for a designed image
// (public/og-image.png + a static export) once real brand assets exist.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#171717";
const PAPER = "#FAFAF8";
const LIME = "#D7EE46";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: PAPER,
          padding: 80,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              backgroundColor: LIME,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 700,
              color: INK,
            }}
          >
            C
          </div>
          <span style={{ fontSize: 28, fontWeight: 600, color: INK }}>
            Clarly
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              fontSize: 56,
              fontWeight: 600,
              color: INK,
              lineHeight: 1.1,
              maxWidth: 900,
            }}
          >
            WhatsApp support your customers actually feel heard by.
          </div>
          <div style={{ fontSize: 26, color: "#57534E", maxWidth: 820 }}>
            Answers from your own knowledge base. Hands off to a human the
            moment it should.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
