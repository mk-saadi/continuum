// Header context: whether the active tab is a casual Chat or a Workspace Chat.
// `tab.projectId` is the authoritative session/project relationship already
// owned by TabContext and tabState — never the tab title or a text label.
// Returns null for a casual chat, otherwise the identity/navigation block the
// Header renders. On the workspace home page (view 'projects') there is no
// single-workspace name to show, so `name` is null and only Home renders.
// Navigation reuses the existing tab.view mechanism:
//   home       → view 'projects'  (App.jsx renders ProjectsView)
//   workspace  → view 'project'   (App.jsx renders ProjectWorkspace), id kept
export const workspaceHeaderFor = (tab, projects = [], update) => {
  if (!tab.projectId) return null;
  return {
    name: tab.view === 'projects'
      ? null
      : projects.find(project => project.id === tab.projectId)?.name || 'Workspace',
    onOpenHome: () => update({ view: 'projects' }),
    onOpenWorkspace: () => update({ projectId: tab.projectId, view: 'project' }),
  };
};
