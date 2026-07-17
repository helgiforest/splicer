import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// best-effort renderer error capture -> electron/main.cjs -> logs/*.log,
// so a bug report can be a log file instead of a DevTools screenshot.
// securitypolicyviolation matters most here: a blocked CSP directive
// (e.g. a missing img-src scheme) doesn't throw, so nothing else catches it.
if (window.meridian?.logError) {
  window.addEventListener("error", (e) => {
    window.meridian.logError(`error: ${e.message} at ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    window.meridian.logError(`unhandledrejection: ${e.reason?.stack || e.reason}`);
  });
  document.addEventListener("securitypolicyviolation", (e) => {
    window.meridian.logError(
      `securitypolicyviolation: ${e.violatedDirective} blocked ${e.blockedURI}`
    );
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
