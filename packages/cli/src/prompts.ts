import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/** Plain text prompt with optional default. */
export async function promptText(question: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer.length > 0 ? answer : defaultValue;
  } finally {
    rl.close();
  }
}

/** y/n confirmation with a default. */
export async function confirm(question: string, defaultValue: boolean): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    return defaultValue;
  } finally {
    rl.close();
  }
}

/**
 * Masked (no-echo) prompt for secrets. Handles backspace and Ctrl-C.
 * The value is never logged and never written to disk by the caller.
 */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';
    const wasRaw = stdin.isRaw;

    stdout.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          // Ctrl-C
          stdout.write('\n');
          cleanup();
          reject(new Error('interrupted'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          stdout.write('\n');
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
