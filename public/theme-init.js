// Applies the saved theme before the first paint, so a dark-mode user never sees a white flash.
// Reads the same "mde:settings" key the app writes (see src/client/app/main.js).
try {
  var s = JSON.parse(localStorage.getItem("mde:settings") || "{}").theme || "system";
  document.documentElement.dataset.theme = s === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s;
} catch (e) { document.documentElement.dataset.theme = "light"; }
