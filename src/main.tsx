import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const preloadRecoveryKey = `vite-preload-recovery:${__GIT_COMMIT__}`;

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();

  if (sessionStorage.getItem(preloadRecoveryKey)) {
    return;
  }

  sessionStorage.setItem(preloadRecoveryKey, "1");
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
