/**
 * Parsing of Code for IBM i Object Browser nodes into library/file/member
 * details. Kept free of the `vscode` module so it can be unit tested.
 */

/** Loose shape of the Object Browser nodes we read from — every field is optional and varies by Code for IBM i version. */
export interface BrowserNode {
  resourceUri?: unknown;
  path?: unknown;
  object?: { library?: string; name?: string };
  library?: string;
  file?: string;
  name?: string;
  extension?: string;
  label?: string | { label: string };
  member?: {
    library?: string;
    file?: string;
    sourceFile?: string;
    name?: string;
    member?: string;
    extension?: string;
  };
  _filter?: { library?: string; object?: string };
}

/** The parts of a URI the parsers need, already decoded. */
export interface UriParts {
  scheme: string;
  path: string;
}

export interface SourceFileInfo {
  library: string;
  sourceFile: string;
}

export interface MemberInfo extends SourceFileInfo {
  memberName: string;
  extension: string;
}

function splitNameAndExtension(lastPart: string): { name: string; extension?: string } {
  const dotIdx = lastPart.lastIndexOf(".");
  return dotIdx > 0
    ? { name: lastPart.substring(0, dotIdx), extension: lastPart.substring(dotIdx + 1) }
    : { name: lastPart };
}

export function extractSourceFileInfo(
  node: BrowserNode | undefined,
  uri?: UriParts
): SourceFileInfo | undefined {
  if (!node) {
    return undefined;
  }

  // Pattern 1: Code for i SPF tree item — node.object has library/name
  if (node.object?.library && node.object?.name) {
    return { library: node.object.library, sourceFile: node.object.name };
  }

  // Pattern 2: node.path is "LIBRARY/FILE"
  if (typeof node.path === "string") {
    const parts = node.path.split("/").filter(Boolean);
    if (parts.length === 2) {
      return { library: parts[0], sourceFile: parts[1] };
    }
  }

  // Pattern 3: resourceUri — scheme "object", path "/LIBRARY/FILE.TYPE"
  if (uri?.scheme === "object") {
    const parts = uri.path.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const library = parts[parts.length - 2];
      const { name: fileName } = splitNameAndExtension(parts[parts.length - 1]);
      return { library, sourceFile: fileName };
    }
  }

  // Pattern 4: direct properties (library, file/name)
  const sourceFile = node.file || node.name;
  if (node.library && sourceFile) {
    return { library: node.library, sourceFile };
  }

  return undefined;
}

export function extractMemberInfo(
  node: BrowserNode | undefined,
  uri?: UriParts
): MemberInfo | undefined {
  if (!node) {
    return undefined;
  }

  let result: MemberInfo | undefined;

  // Pattern 1: resourceUri based (member:// scheme) — most reliable for Code for i
  if (uri?.scheme === "member") {
    const parts = uri.path.split("/").filter(Boolean);
    if (parts.length >= 3) {
      // Use the final three path components.
      // This supports both:
      //   /LIBRARY/SOURCEFILE/MEMBER.EXT
      //   /CONNECTION/LIBRARY/SOURCEFILE/MEMBER.EXT
      const library = parts[parts.length - 3];
      const sourceFile = parts[parts.length - 2];
      const { name, extension = "mbr" } = splitNameAndExtension(parts[parts.length - 1]);

      result = {
        library,
        sourceFile,
        memberName: name,
        extension: extension.toLowerCase(),
      };
    }
  }

  // Pattern 2: node has path property like "/QSYS.LIB/MYLIB.LIB/QRPGLESRC.FILE/MYPROG.MBR"
  if (!result && typeof node.path === "string") {
    const match = node.path.match(
      /\/QSYS\.LIB\/([^.]+)\.LIB\/([^.]+)\.FILE\/([^.]+)\.(\w+)/i
    );
    if (match) {
      result = {
        library: match[1],
        sourceFile: match[2],
        memberName: match[3],
        extension: match[4].toLowerCase(),
      };
    }
  }

  // Pattern 3: node has direct properties (library, file, name)
  if (!result && node.library && node.file && node.name) {
    result = {
      library: node.library,
      sourceFile: node.file,
      memberName: node.name,
      extension: (node.extension || "mbr").toLowerCase(),
    };
  }

  // Pattern 4: node has member property with nested info
  if (!result && node.member) {
    const lib = node.member.library || node.library;
    const file = node.member.file || node.member.sourceFile || node.file;
    const name = node.member.name || node.member.member;
    const ext = node.member.extension || "mbr";

    if (lib && file && name) {
      result = {
        library: lib,
        sourceFile: file,
        memberName: name,
        extension: ext.toLowerCase(),
      };
    }
  }

  // Pattern 5: Code for i MemberItem — has _filter with library/object
  if (!result && node._filter) {
    const lib = node._filter.library;
    const file = node._filter.object;
    const label = typeof node.label === "string" ? node.label : node.label?.label;
    const name = label || node.name;
    const ext = node.extension || "mbr";

    if (lib && file && name) {
      result = {
        library: lib,
        sourceFile: file,
        memberName: name,
        extension: ext.toLowerCase(),
      };
    }
  }

  // Validate: all fields must be non-empty strings
  if (result && (!result.library || !result.sourceFile || !result.memberName || !result.extension)) {
    return undefined;
  }

  return result;
}
