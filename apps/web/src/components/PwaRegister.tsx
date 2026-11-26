"use client";

// Registers the service worker so the dashboard can be installed as an app.
// Browsers only allow this on https or on localhost; over plain http on Wi-Fi
// "Add to Home Screen" still works, just without the offline page.
import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
