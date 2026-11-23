import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./main";
import { captureSignupSource } from "./signup-source";

captureSignupSource();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
