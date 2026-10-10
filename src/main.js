import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/components.css";
import { startApp } from "./app.js";

startApp().catch(err => {
  console.error(err);
  const root = document.getElementById("app");
  if (root) root.textContent = "Cold couldn't start. Reload the page. Your saved products and drafts have not been changed.";
});
