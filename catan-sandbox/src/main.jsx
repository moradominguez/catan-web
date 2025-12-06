import React from "react";
import ReactDOM from "react-dom/client";
import CatanSandbox from "./CatanSandbox.jsx";   // <-- our sandbox
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div style={{ position: "absolute", top: 10, left: 10, zIndex: 9999, color: "white" }}>
      SANDBOX ROOT
    </div>
    <CatanSandbox />
  </React.StrictMode>
);
