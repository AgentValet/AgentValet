// Pass-through stdout parser — underlying adapter handles its own transcript format
export function parseStdout(line: string): Array<{ type: string; content: string }> {
  return [{ type: "text", content: line }];
}
