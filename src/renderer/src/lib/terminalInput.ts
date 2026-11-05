/**
 * The printable text in a chunk of terminal input: escape sequences (cursor keys, the markers a bracketed
 * paste is wrapped in) and other control characters are dropped. Used to keep track of what was typed on
 * the current line.
 */
export function printableInput(data: string): string {
  return (
    data
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
  );
}

/**
 * True for data the terminal itself sends back after the program asked it something (fish asks for the
 * background colour, the cursor position and the device attributes before every prompt): device attribute
 * and cursor position reports, OSC and DCS replies, the kitty keyboard reply, focus reports. xterm.js sends
 * these through the same `onData` as keystrokes, but they are not typed.
 */
export function isTerminalReply(data: string): boolean {
  return (
    // eslint-disable-next-line no-control-regex
    /^\x1b\[\?[\d;]*(?:c|u|\$y)$/.test(data) || // DA1, kitty keyboard flags, DECRPM
    // eslint-disable-next-line no-control-regex
    /^\x1b\[>[\d;]*c$/.test(data) || // DA2
    // eslint-disable-next-line no-control-regex
    /^\x1b\[\d+;\d+R$/.test(data) || // cursor position report
    // eslint-disable-next-line no-control-regex
    /^\x1b\[[IO]$/.test(data) || // focus in / out
    // eslint-disable-next-line no-control-regex
    /^\x1b[\]P][^\x1b\x07]*(?:\x07|\x1b\\)$/.test(data) // OSC / DCS replies (colours, XTVERSION)
  );
}
