/**
 * Saves a Blob as a file through a temporary link. The object URL is revoked after a delay, because
 * some browsers start reading it only after click() returns.
 */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.style.display = "none";
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
