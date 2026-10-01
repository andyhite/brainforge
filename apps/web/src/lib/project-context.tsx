import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "brainforge.projectRoot";

interface ProjectRootValue {
  root: string | undefined;
  select: (root: string | undefined) => void;
}

const ProjectRootContext = createContext<ProjectRootValue | undefined>(undefined);

export function ProjectRootProvider({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<string | undefined>(() => localStorage.getItem(STORAGE_KEY) ?? undefined);
  const select = useCallback((next: string | undefined) => {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
    setRoot(next);
  }, []);
  const value = useMemo(() => ({ root, select }), [root, select]);
  return <ProjectRootContext.Provider value={value}>{children}</ProjectRootContext.Provider>;
}

export function useProjectRoot(): ProjectRootValue {
  const value = useContext(ProjectRootContext);
  if (!value) throw new Error("useProjectRoot outside ProjectRootProvider");
  return value;
}
