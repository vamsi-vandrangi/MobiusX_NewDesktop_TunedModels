/**
 * Best-effort reconstruction of "the line currently being typed" in an
 * interactive PTY, from the raw input chunks the renderer forwards.
 *
 * This deliberately does NOT implement a real terminal emulator. It only
 * tracks plain printable text, Enter, Backspace/Delete, and Ctrl+C/Ctrl+U
 * (both treated as "line cleared"). Anything else — arrow-key history
 * recall, mid-line cursor movement, tab completion, function keys — is a
 * multi-byte escape sequence the shell's own readline interprets; this
 * class can't observe what changed as a result (that state lives inside
 * the shell process, not in the bytes we forwarded), so it skips those
 * chunks for tracking purposes rather than guessing and risking a wrong
 * evaluation. In practice this means: a freshly typed-or-pasted line is
 * reliably tracked; a line recalled via history and then edited may not
 * be. See policy.ts's doc comment for why this is advisory, not a hard
 * boundary, regardless.
 */
export class LineTracker {
  private buffer = "";

  /**
   * Feed one raw input chunk as sent by the client. Returns any complete
   * lines it produced — there can be more than one if a multi-line paste
   * arrived in a single chunk.
   */
  feed(chunk: string): string[] {
    // Bracketed-paste markers: strip, keep the inner pasted text as normal content.
    const text = chunk.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");

    // A multi-byte escape/control sequence we don't interpret (arrow keys, Home/End,
    // function keys, etc.) — skip the whole chunk rather than let stray bytes like the
    // '[' and letter in `\x1b[A` get misread as literally-typed characters.
    if (text.length > 1 && text.startsWith("\x1b")) return [];

    const completed: string[] = [];
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        completed.push(this.buffer);
        this.buffer = "";
      } else if (ch === "\x7f" || ch === "\x08") {
        this.buffer = this.buffer.slice(0, -1);
      } else if (ch === "\x03" || ch === "\x15") {
        // Ctrl+C / Ctrl+U — the shell cancels or clears the line.
        this.buffer = "";
      } else if (ch >= " " || ch === "\t") {
        this.buffer += ch;
      }
      // Any other control byte (including a lone, unhandled ESC) is ignored.
    }
    return completed;
  }

  /** Current partial line, for tests/inspection — not used by policy evaluation, which only fires on completed lines. */
  peek(): string {
    return this.buffer;
  }
}
