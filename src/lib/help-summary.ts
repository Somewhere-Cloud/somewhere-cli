/** Keep the first sentence or line without splitting dotted API names or URLs. */
export function helpSummary(description: string): string {
  return description.trim().split(/\r?\n|(?<=[.!?])\s+(?=[A-Z`])/u, 1)[0];
}
