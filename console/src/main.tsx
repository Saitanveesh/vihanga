import React from "react";
import ReactDOM from "react-dom/client";
import StationAccess from "./StationAccess";
import "./styles.css";
import "./OperationsStyles.css";
import "./ControlStyles.css";
import "./ConnectionSettings.css";
import "./NetworkWatch.css";
import "./VihangaTheme.css";
import "./ObsidianTheme.css";
import "./Station.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><StationAccess /></React.StrictMode>
);
