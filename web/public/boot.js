// Runs before first paint (a blocking same-origin script, which the CSP allows where inline
// script is not). Applies a stored theme and the network so the page never flashes the wrong one.
{
  const root = document.documentElement;
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") root.dataset["theme"] = theme;
  } catch {
    // Storage blocked: the OS setting applies.
  }
  const first = location.pathname.split("/")[1];
  root.dataset["network"] =
    first !== undefined && ["signet", "testnet4", "testnet5", "regtest"].includes(first)
      ? first
      : "mainnet";
}
