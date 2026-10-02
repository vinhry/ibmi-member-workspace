import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { SourceLayout, SourceProblem, codePointLabel, describeProblem, sourceProblems } from "./sourceCheck";
import { CheckedOutMember, isReferenceCopy } from "./types";

const DIAGNOSTIC_SOURCE = "IBM i Member Workspace";
/** Problems shown per file: a file pasted with typographic quotes throughout can have thousands. */
const MAX_DIAGNOSTICS = 500;
const debounceMs = 300;

type FixableProblem = Extract<SourceProblem, { kind: "character" }> & { replacement: string };

/**
 * Warns in the editor about text a checked-out member can't hold (see `sourceCheck.ts`), as it is
 * typed, and offers to replace typographic characters with plain text. Read-only reference copies
 * and checkouts whose source file layout isn't known yet are left alone.
 */
export function registerSourceDiagnostics(context: vscode.ExtensionContext, service: CheckoutService): void {
  const collection = vscode.languages.createDiagnosticCollection("ibmi-member-workspace");
  const pending = new Map<string, NodeJS.Timeout>();
  /** Checkouts whose missing layout was asked for once this session, so typing doesn't query the IBM i. */
  const lookedUp = new Set<string>();

  const update = (document: vscode.TextDocument) => {
    const entry = editableCheckout(service, document);
    const layout = entry?.sourceLayout;
    if (!entry || !layout) {
      collection.delete(document.uri);
      if (entry && !lookedUp.has(entry.id)) {
        lookedUp.add(entry.id);
        // A checkout from before 1.7.10: its layout is read once, if connected to its system.
        void service.sourceLayoutFor(entry).then((found) => found && schedule(document), () => undefined);
      }
      return;
    }
    const problems = sourceProblems(document.getText(), layout).slice(0, MAX_DIAGNOSTICS);
    collection.set(document.uri, problems.map((problem) => toDiagnostic(problem, layout)));
  };

  const schedule = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      update(document);
    }, debounceMs));
  };

  const scheduleOpenCheckouts = () => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === "file") {
        schedule(document);
      }
    }
  };

  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimeout(pending.get(document.uri.toString()));
      pending.delete(document.uri.toString());
      collection.delete(document.uri);
    }),
    // A checkout gains its layout, becomes a reference copy or is discarded.
    service.onDidChange(scheduleOpenCheckouts),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new PlainTextFixes(service),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    {
      dispose: () => {
        for (const timer of pending.values()) {
          clearTimeout(timer);
        }
        pending.clear();
      },
    }
  );
  scheduleOpenCheckouts();
}

/** Opens the checkout's local file at its first problem and shows the Problems view. */
export async function showSourceProblems(entry: CheckedOutMember, first?: SourceProblem): Promise<void> {
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(entry.localPath));
  if (first) {
    const range = rangeOf(first);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  await vscode.commands.executeCommand("workbench.actions.view.problems");
}

function editableCheckout(service: CheckoutService, document: vscode.TextDocument): CheckedOutMember | undefined {
  if (document.uri.scheme !== "file") {
    return undefined;
  }
  const entry = service.findEntryByLocalPath(document.uri.fsPath);
  return entry && !isReferenceCopy(entry) ? entry : undefined;
}

function rangeOf(problem: SourceProblem): vscode.Range {
  return new vscode.Range(problem.line, problem.column, problem.line, problem.end);
}

function toDiagnostic(problem: SourceProblem, layout: SourceLayout): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(rangeOf(problem), describeProblem(problem, layout), vscode.DiagnosticSeverity.Warning);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = problem.kind;
  return diagnostic;
}

function isFixable(problem: SourceProblem): problem is FixableProblem {
  return problem.kind === "character" && problem.replacement !== undefined;
}

/** Quick fixes that replace typographic characters with their plain-text spelling. */
class PlainTextFixes implements vscode.CodeActionProvider {
  constructor(private readonly service: CheckoutService) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (!context.diagnostics.some((diagnostic) => diagnostic.source === DIAGNOSTIC_SOURCE && diagnostic.code === "character")) {
      return [];
    }
    const layout = editableCheckout(this.service, document)?.sourceLayout;
    if (!layout) {
      return [];
    }
    const fixable = sourceProblems(document.getText(), layout).filter(isFixable);
    const here = fixable.filter((problem) => range.intersection(rangeOf(problem)) !== undefined);
    const actions = here.map((problem, index) => {
      const what = `"${problem.char}" (${codePointLabel(problem.char)})`;
      const title = problem.replacement === ""
        ? `Remove ${what}`
        : `Replace ${what} with ${JSON.stringify(problem.replacement)}`;
      return fixAction(title, document, [problem], index === 0);
    });
    if (fixable.length > here.length || fixable.length > 1) {
      actions.push(fixAction(
        `Replace all ${fixable.length} typographic characters in this file with plain text`,
        document,
        fixable,
        false
      ));
    }
    return actions;
  }
}

function fixAction(
  title: string,
  document: vscode.TextDocument,
  problems: readonly FixableProblem[],
  preferred: boolean
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  for (const problem of problems) {
    action.edit.replace(document.uri, rangeOf(problem), problem.replacement);
  }
  action.isPreferred = preferred;
  return action;
}
