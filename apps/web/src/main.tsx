import "./zod-jitless.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { ProjectRootProvider } from "./lib/project-context.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnReconnect: true } },
});

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ProjectRootProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ProjectRootProvider>
    </QueryClientProvider>
  </StrictMode>,
);
