import { LuMessageCircle, LuFolder } from 'react-icons/lu';

/**
 * Returns the appropriate icon component and accessibility label for a tab
 * based on whether it belongs to a project or is a casual chat.
 *
 * @param {{ projectId: string | null }} tab
 * @returns {{ Icon: React.ComponentType, label: string }}
 */
export const getTabTypeIcon = (tab) => {
  if (tab.projectId) {
    return { Icon: LuFolder, label: 'Project' };
  }
  return { Icon: LuMessageCircle, label: 'Casual chat' };
};
