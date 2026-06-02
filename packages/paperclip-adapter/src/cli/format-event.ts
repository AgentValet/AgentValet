import pc from "picocolors";

export function formatEvent(line: string): string {
  if (line.includes("AGENTVALET_AGENT_TOKEN")) {
    // Never print the token to terminal
    return pc.dim("[agentvalet] (token injected — redacted)");
  }
  if (line.includes("[agentvalet]")) {
    return pc.cyan("[agentvalet]") + line.replace("[agentvalet]", "");
  }
  return line;
}
