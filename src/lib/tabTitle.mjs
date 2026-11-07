// Page labels are derived so background chat updates cannot replace them,
// and returning to chat restores the conversation's current title.
export function getTabTitle(tab, projects = []) {
  if (tab.view === 'tasks') return 'Tasks';
  if (tab.view === 'projects') return 'All Projects';
  if (tab.view === 'project') {
    return projects.find(project => project.id === tab.projectId)?.name || 'Project';
  }
  return tab.title || 'New chat';
}
