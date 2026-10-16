/** Minimal CLI logger (same output as `@react-native-community/cli-tools`' logger), so the CLI
 * does not depend on that optional peer. `--json` disables it: stdout then carries one JSON
 * object only. */
let disabled = false;

const paint = (stream: NodeJS.WriteStream, code: string, label: string) =>
  stream.isTTY && !process.env.NO_COLOR
    ? `\u001b[1m\u001b[${code}m${label}\u001b[39m\u001b[22m`
    : label;

export const logger = {
  success: (message: string) => {
    if (!disabled)
      console.log(`${paint(process.stdout, '32', 'success')} ${message}`);
  },
  info: (message: string) => {
    if (!disabled)
      console.log(`${paint(process.stdout, '36', 'info')} ${message}`);
  },
  warn: (message: string) => {
    if (!disabled)
      console.warn(`${paint(process.stderr, '33', 'warn')} ${message}`);
  },
  error: (message: string) => {
    if (!disabled)
      console.error(`${paint(process.stderr, '31', 'error')} ${message}`);
  },
  disable: () => {
    disabled = true;
  },
  enable: () => {
    disabled = false;
  },
};
