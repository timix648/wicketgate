import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, Link, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Overview } from "./pages/Overview";
import { RollupDetail, RollupList } from "./pages/Rollups";
import { BatchDetail } from "./pages/BatchDetail";
import { Watchers } from "./pages/Watchers";
import { Exits } from "./pages/Exits";
import { Track } from "./pages/Track";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } },
});

// Hash routing so the built board works on any static host without rewrite rules.
const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: "rollups", element: <RollupList /> },
      { path: "rollups/:rollupId", element: <RollupDetail /> },
      { path: "rollups/:rollupId/batches/:index", element: <BatchDetail /> },
      { path: "watchers", element: <Watchers /> },
      { path: "exits", element: <Exits /> },
      { path: "track", element: <Track /> },
      { path: "track/:address", element: <Track /> },
      { path: "*", element: <div className="card empty" style={{ marginTop: 32 }}>Nothing here. <Link to="/">Back to the overview</Link></div> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
