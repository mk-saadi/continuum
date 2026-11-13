import { createContext, useContext } from 'react';

// Scoped to a mounted chat so background tabs cannot open another tab's preview.
export const WorkspacePreviewContext = createContext(null);
export const useWorkspacePreview = () => useContext(WorkspacePreviewContext);
