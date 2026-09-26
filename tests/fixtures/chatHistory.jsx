import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatHistory from '../../src/components/ChatHistory';
function Fixture() {
  const [groups, setGroups] = useState([
    { folder_name: 'Empty folder', sessions: [] },
    { folder_name: 'Projects', sessions: [{ id: 'a', title: 'Project notes', folder_name: 'Projects', total_tokens: 12000 }] },
    { folder_name: 'Uncategorized', sessions: [{ id: 'b', title: 'Weekend ideas', folder_name: 'Uncategorized', total_tokens: 321 }] },
  ]);
  return <div style={{ height: 600, overflow: 'hidden', width: 272 }}><ChatHistory groups={groups} activeId="a" onLoad={() => {}} onNew={() => {}}
    onAction={async (kind, id, value) => {
      window.lastAction = { kind, id, value };
      setGroups(current => {
        if (kind === 'New Folder') return [...current, { folder_name: value, sessions: [] }];
        if (kind === 'Move to Folder') {
          const session = current.flatMap(group => group.sessions).find(session => session.id === id);
          return current.map(group => ({ ...group, sessions: [...group.sessions.filter(session => session.id !== id), ...(group.folder_name === value ? [{ ...session, folder_name: value }] : [])] }));
        }
        return current;
      });
    }} /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
