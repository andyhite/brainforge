import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationError, Problem } from "@brainforge/contracts";
import { callOperation, NetworkError } from "../api/client.ts";
import { useMutationOperation, useOperation } from "../api/hooks.ts";
import { useSpecChanged } from "../api/events.tsx";
import { useProjectRoot } from "./project-context.tsx";

interface Baseline {
  /** Hash the draft is based on; null when the file does not exist yet (exclusive create). */
  hash: string | null;
  text: string;
}

interface DiskState {
  hash: string | null;
  text: string;
}

interface ConflictState {
  mine: string;
  disk: DiskState;
}

export interface SpecFile {
  path: string;
  loading: boolean;
  loadError: OperationError | NetworkError | undefined;
  missing: boolean;
  draft: string;
  setDraft: (text: string) => void;
  dirty: boolean;
  /** Problems reported by the server for the last read or save of this file. */
  problems: Problem[];
  save: () => Promise<void>;
  saving: boolean;
  saveError: OperationError | NetworkError | undefined;
  savedHash: string | undefined;
  /** Disk changed under a dirty draft; the draft is never overwritten without a choice. */
  externalChange: DiskState | undefined;
  dismissExternalChange: () => void;
  loadDisk: () => void;
  discardDraft: () => void;
  refresh: () => void;
  conflict: ConflictState | undefined;
  resolveKeepMine: () => Promise<void>;
  resolveLoadDisk: () => void;
  closeConflict: () => void;
}

/** Draft/baseline/conflict state for one authored YAML file, shared by the field form and the YAML editor. */
export function useSpecFile(path: string): SpecFile {
  const read = useOperation("spec.read", { path });
  const write = useMutationOperation("spec.write");
  const { root } = useProjectRoot();
  const [baseline, setBaseline] = useState<Baseline | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [externalChange, setExternalChange] = useState<DiskState | undefined>(undefined);
  const [conflict, setConflict] = useState<ConflictState | undefined>(undefined);
  const [saveError, setSaveError] = useState<OperationError | NetworkError | undefined>(undefined);
  const [savedHash, setSavedHash] = useState<string | undefined>(undefined);
  const lastDiskHash = useRef<string | null | undefined>(undefined);
  const dismissedHash = useRef<string | null | undefined>(undefined);
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  draftRef.current = draft;
  baselineRef.current = baseline;

  // Reset when switching file or project.
  useEffect(() => {
    setBaseline(undefined);
    setDraft("");
    setProblems([]);
    setExternalChange(undefined);
    setConflict(undefined);
    setSaveError(undefined);
    setSavedHash(undefined);
    lastDiskHash.current = undefined;
    dismissedHash.current = undefined;
  }, [path, root]);

  const envelope = read.data;
  let disk: DiskState | undefined;
  let loadError: OperationError | undefined;
  let diskProblems: Problem[] = [];
  if (envelope?.ok) {
    disk = { hash: envelope.data.hash, text: envelope.data.text };
    diskProblems = envelope.data.problems;
  } else if (envelope && envelope.error.code === "NOT_FOUND") {
    disk = { hash: null, text: "" };
  } else if (envelope) {
    loadError = envelope.error;
  }

  const diskHash = disk?.hash;
  const diskText = disk?.text;
  useEffect(() => {
    if (diskText === undefined || diskHash === undefined) return;
    if (lastDiskHash.current === diskHash) return;
    const incoming: DiskState = { hash: diskHash, text: diskText };
    const first = lastDiskHash.current === undefined;
    lastDiskHash.current = diskHash;
    setProblems(diskProblems);
    const current = baselineRef.current;
    if (first || !current || draftRef.current === current.text) {
      setBaseline({ hash: incoming.hash, text: incoming.text });
      setDraft(incoming.text);
      setExternalChange(undefined);
    } else if (current.hash !== incoming.hash && dismissedHash.current !== incoming.hash) {
      setExternalChange(incoming);
    }
    // diskProblems is derived from the same envelope as the hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diskHash, diskText]);

  const { refetch } = read;
  const refresh = useCallback(() => void refetch(), [refetch]);
  useSpecChanged(refresh);
  useEffect(() => {
    // The spec files are edited outside the app too: rescan whenever the user comes back to this window.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const submit = useCallback(async (text: string, expectedHash: string | null) => {
    setSaveError(undefined);
    let result;
    try {
      result = await write.mutateAsync({ input: { path, text, expectedHash } });
    } catch (error) {
      setSaveError(error instanceof NetworkError ? error : new NetworkError("Save failed."));
      return "failed" as const;
    }
    if (result.ok) {
      lastDiskHash.current = result.data.hash;
      setBaseline({ hash: result.data.hash, text });
      setProblems(result.data.problems);
      setSavedHash(result.data.hash);
      setExternalChange(undefined);
      return "saved" as const;
    }
    if (result.error.code === "SPEC_CONFLICT") {
      const fresh = await callOperation("spec.read", { project: root, input: { path } }).catch((): undefined => undefined);
      let latest: DiskState | undefined;
      if (fresh?.ok) latest = { hash: fresh.data.hash, text: fresh.data.text };
      else if (fresh && fresh.error.code === "NOT_FOUND") latest = { hash: null, text: "" };
      if (latest) {
        setConflict({ mine: text, disk: latest });
        return "conflict" as const;
      }
    }
    setSaveError(result.error);
    return "failed" as const;
  }, [path, root, write]);

  const save = useCallback(async () => {
    const current = baselineRef.current;
    if (!current) return;
    await submit(draftRef.current, current.hash);
  }, [submit]);

  const resolveKeepMine = useCallback(async () => {
    if (!conflict) return;
    const outcome = await submit(conflict.mine, conflict.disk.hash);
    if (outcome === "saved") setConflict(undefined);
  }, [conflict, submit]);

  const resolveLoadDisk = useCallback(() => {
    if (!conflict) return;
    lastDiskHash.current = conflict.disk.hash;
    setBaseline({ hash: conflict.disk.hash, text: conflict.disk.text });
    setDraft(conflict.disk.text);
    setExternalChange(undefined);
    setConflict(undefined);
  }, [conflict]);

  const loadDisk = useCallback(() => {
    if (!externalChange) return;
    setBaseline({ hash: externalChange.hash, text: externalChange.text });
    setDraft(externalChange.text);
    setExternalChange(undefined);
  }, [externalChange]);

  const dismissExternalChange = useCallback(() => {
    dismissedHash.current = externalChange?.hash;
    setExternalChange(undefined);
  }, [externalChange]);

  const discardDraft = useCallback(() => {
    if (baselineRef.current) setDraft(baselineRef.current.text);
  }, []);

  const closeConflict = useCallback(() => setConflict(undefined), []);

  return {
    path,
    loading: read.isPending || (baseline === undefined && loadError === undefined && !read.isError),
    loadError: loadError ?? read.error ?? undefined,
    missing: baseline?.hash === null,
    draft,
    setDraft,
    dirty: baseline !== undefined && draft !== baseline.text,
    problems,
    save,
    saving: write.isPending,
    saveError,
    savedHash,
    externalChange,
    dismissExternalChange,
    loadDisk,
    discardDraft,
    refresh,
    conflict,
    resolveKeepMine,
    resolveLoadDisk,
    closeConflict,
  };
}
