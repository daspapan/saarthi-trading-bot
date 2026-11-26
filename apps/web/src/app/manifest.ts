import type { MetadataRoute } from "next";

// Lets the dashboard be added to a phone's home screen and open full screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Saarthi: AI analyst, never the trader",
    short_name: "Saarthi",
    description: "Testnet trading dashboard. Virtual funds only.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f6f9",
    theme_color: "#0369a1",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
