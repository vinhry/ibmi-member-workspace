/** The levels of a boolean setting, as `WorkspaceConfiguration.inspect` reports them. */
export interface InspectedFlag {
  defaultValue?: boolean;
  globalValue?: boolean;
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
}

export type GitIntegrationState = "on" | "off" | "needsConfirmation";

/**
 * Whether Local Change History is on. User settings are followed as they are. A workspace or
 * folder setting can turn it off, but turns it on only once the user confirmed it for this
 * workspace (Set Up Local Change History does): a cloned project's .vscode/settings.json
 * must not start running Git in the checkout folder on its own.
 */
export function gitIntegrationState(inspected: InspectedFlag | undefined, confirmedHere: boolean): GitIntegrationState {
  const workspaceValue = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
  if (workspaceValue !== undefined) {
    return !workspaceValue ? "off" : confirmedHere ? "on" : "needsConfirmation";
  }
  return inspected?.globalValue ?? inspected?.defaultValue ?? false ? "on" : "off";
}
