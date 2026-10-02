import * as path from "node:path";
import * as vscode from "vscode";
import { bobPasteSteps } from "../bobIde";
import { errorMessage } from "../errors";

/** A chat whose input box an extension can fill only through the clipboard, such as Bob's or Codex's. */
export interface PasteTarget {
  /** The name the user knows it by, e.g. "Bob" or "Codex". */
  name: string;
  /** Its chat's webview views, best first; when a paste misses one, the next is tried. */
  views: readonly string[];
  /** A command that focuses its input box, if it has one. */
  focusInput?: string;
  /** Prefix of its lines in the output panel, e.g. "[bob]". */
  logTag: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Puts `prompt` in a chat's input box without sending it: focus the chat, then paste. It stays on
 * the clipboard, so the user can paste it themselves if that didn't land. The steps are the ones
 * worked out for Bob (see `bobPasteSteps`); they suit any chat in a webview view.
 */
export async function pasteIntoChat(prompt: string, target: PasteTarget, log: vscode.OutputChannel): Promise<void> {
  const { name, logTag, focusInput } = target;
  await vscode.env.clipboard.writeText(prompt);
  const onClipboard = `The prompt is on the clipboard. Open ${name}'s chat, paste it, review it, and press Enter.`;
  if (target.views.length === 0) {
    log.appendLine(`${logTag} No ${name} chat view found; the prompt was only copied to the clipboard.`);
    vscode.window.showInformationMessage(onClipboard);
    return;
  }
  // No extension can tell whether the chat is open, so it is opened and given time to load. A
  // hidden chat can take longer than that; a paste that lands in an editor is undone and tried
  // once more with a longer wait.
  let missed: vscode.TextDocument | undefined;
  for (const view of target.views) {
    for (const loadWaitMs of [600, 1500]) {
      try {
        missed = await pasteInto(view, focusInput, prompt, loadWaitMs);
      } catch (err) {
        log.appendLine(`${logTag} Could not paste the prompt into ${name}'s chat (${view}): ${errorMessage(err)}`);
        missed = undefined;
        break;
      }
      if (!missed) {
        log.appendLine(`${logTag} Prompt pasted into ${name}'s chat (${view}${focusInput ? `, ${focusInput}` : ""}).`);
        vscode.window.showInformationMessage(
          `The prompt is in ${name}'s chat: review it and press Enter. If the chat box is empty, paste it (it's on the clipboard).`
        );
        return;
      }
      await vscode.window.showTextDocument(missed);
      await vscode.commands.executeCommand("undo");
      log.appendLine(`${logTag} The prompt was pasted into ${missed.uri.fsPath} instead of ${name}'s chat (after ${loadWaitMs} ms); undone.`);
    }
  }
  if (!missed) {
    vscode.window.showInformationMessage(onClipboard);
    return;
  }
  vscode.window.showWarningMessage(
    `${name}'s chat didn't take the focus, so the prompt went into ${path.basename(missed.uri.fsPath)}; that was undone. ` +
    `The prompt is on the clipboard: paste it into ${name}'s chat and press Enter.`
  );
}

/**
 * Focuses the chat view and pastes the clipboard into it (see `bobPasteSteps`). Returns the
 * document the paste landed in instead, if any.
 */
async function pasteInto(
  view: string,
  focusInput: string | undefined,
  prompt: string,
  loadWaitMs: number
): Promise<vscode.TextDocument | undefined> {
  const firstLine = prompt.split("\n")[0];
  let pastedInto: vscode.TextDocument | undefined;
  const watch = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.some((change) => change.text.includes(firstLine))) {
      pastedInto = event.document;
    }
  });
  try {
    for (const step of bobPasteSteps(view, loadWaitMs, focusInput)) {
      if ("command" in step) {
        await vscode.commands.executeCommand(step.command);
      } else {
        await delay(step.waitMs);
      }
    }
  } finally {
    watch.dispose();
  }
  return pastedInto;
}
