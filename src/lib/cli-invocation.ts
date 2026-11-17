/** npm sets npm_command=exec for both npx and npm exec. */
export function cliInvocation(): string {
  return process.env.npm_command === 'exec' ? 'npx -y @somewhere-cloud/cli@latest' : 'somewhere';
}
