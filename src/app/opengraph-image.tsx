import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "FraudShield — forensic fraud scores in seconds";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #11151f 0%, #1b2231 100%)",
          color: "#f3f6fa",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 34,
            fontWeight: 700,
            color: "#2fb6c9",
            letterSpacing: -1,
          }}
        >
          FraudShield
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 66,
            fontWeight: 700,
            lineHeight: 1.1,
            marginTop: 24,
            maxWidth: 900,
          }}
        >
          Forensic fraud scores in seconds.
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 28,
            color: "#9fb0c3",
            marginTop: 24,
            maxWidth: 840,
          }}
        >
          Catch forged pay stubs, bank statements & invoices — before they cost
          you money.
        </div>
      </div>
    ),
    { ...size }
  );
}
